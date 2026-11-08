import { ActionableError, Dimensions, ScreenElement } from "../robot";
import { isInteractive } from "../format-elements";
import { scoreElement } from "./lexical";
import { imageToScreenPoint } from "../coordinate-mapping";
import { joinUrl, postJson } from "./http";
import { elementCenter, LocateContext, LocateOutcome, Locator, Point } from "./types";

export interface VisionConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs: number;
}

export type VisionScale = "1000" | "normalized" | "pixels";

const SYSTEM_PROMPT = [
	"You locate user interface elements in mobile app screenshots.",
	"Reply with only one JSON object and nothing else.",
	"If the element is visible: {\"found\": true, \"x\": <0-1000>, \"y\": <0-1000>, \"scale\": 1000}, where x and y are the centre of the element, as thousandths of the image width and height from the top-left corner.",
	"If it is not visible: {\"found\": false}.",
].join("\n");

export const buildVisionPrompt = (query: string): { system: string, user: string } => ({
	system: SYSTEM_PROMPT,
	user: `Find this element: ${query}`,
});

/**
 * Picks the unit of the model's numbers: a scale the model declares wins,
 * then 0-1 fractions, then anything above 1000 must be pixels, and whatever is
 * left is read as 0-1000, the unit the prompt asks for.
 */
export const resolveScale = (values: number[], declared: unknown): VisionScale => {
	if (declared === 1000 || declared === "1000") {
		return "1000";
	}

	if (declared === 1 || declared === "1" || declared === "normalized") {
		return "normalized";
	}

	if (declared === "pixels" || declared === "px") {
		return "pixels";
	}

	if (values.every(value => value <= 1) && values.some(value => !Number.isInteger(value))) {
		return "normalized";
	}

	if (values.some(value => value > 1000)) {
		return "pixels";
	}

	return "1000";
};

const SCALE_LABEL: Record<VisionScale, string> = { "1000": "0-1000", "normalized": "0-1", "pixels": "pixels" };

const toImagePixels = (point: Point, scale: VisionScale, image: Dimensions): Point => {
	switch (scale) {
		case "1000": return { x: point.x / 1000 * image.width, y: point.y / 1000 * image.height };
		case "normalized": return { x: point.x * image.width, y: point.y * image.height };
		case "pixels": return point;
	}
};

const quoteReply = (text: string): string => JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}...` : text);

// every {...} in the text that parses as json, outermost first
const jsonObjects = (text: string): any[] => {
	const found: any[] = [];
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
			try {
				const value = JSON.parse(text.slice(start, end + 1));
				if (value && typeof value === "object" && !Array.isArray(value)) {
					found.push(value);
					start = end;
					break;
				}
			} catch {
				// keep shrinking
			}
		}
	}

	return found;
};

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const pointFromObject = (value: any): { point: Point, values: number[] } | null => {
	const x = Number(value.x);
	const y = Number(value.y);
	if (value.x !== undefined && value.y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
		return { point: { x, y }, values: [x, y] };
	}

	const box = value.bbox ?? value.box ?? value.bbox_2d;
	if (Array.isArray(box) && box.length === 4 && box.every(isNumber)) {
		const [x1, y1, x2, y2] = box;
		return { point: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, values: box };
	}

	if (Array.isArray(value.point) && value.point.length === 2 && value.point.every(isNumber)) {
		return { point: { x: value.point[0], y: value.point[1] }, values: value.point };
	}

	return null;
};

// "<point>512 300</point>", "(512, 300)" and "[512, 300]" from grounding models
const pointFromText = (text: string): { point: Point, values: number[] } | null => {
	const match = text.match(/<point>\s*\(?\s*([\d.]+)\s*[ ,]\s*([\d.]+)\s*\)?\s*<\/point>/i)
		?? text.match(/[([]\s*([\d.]+)\s*,\s*([\d.]+)\s*[)\]]/);
	if (!match) {
		return null;
	}

	const x = Number(match[1]);
	const y = Number(match[2]);
	return Number.isFinite(x) && Number.isFinite(y) ? { point: { x, y }, values: [x, y] } : null;
};

/**
 * Reads the model's answer as a point in image pixels, or null when the model
 * says the element is not there. Throws on anything it cannot read.
 */
export const parseVisionPoint = (text: string, image: Dimensions): { point: Point, scale: VisionScale } | null => {
	for (const value of jsonObjects(text)) {
		if (value.found === false) {
			return null;
		}

		const parsed = pointFromObject(value);
		if (parsed) {
			return checkPoint(parsed.point, resolveScale(parsed.values, value.scale), image, text);
		}
	}

	const parsed = pointFromText(text);
	if (parsed) {
		return checkPoint(parsed.point, resolveScale(parsed.values, undefined), image, text);
	}

	throw new ActionableError(`Could not read a position from the vision model's reply: ${quoteReply(text)}`);
};

const checkPoint = (raw: Point, scale: VisionScale, image: Dimensions, text: string): { point: Point, scale: VisionScale } => {
	const point = toImagePixels(raw, scale, image);
	if (point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height) {
		throw new ActionableError(`The vision model's position is outside the screenshot: ${quoteReply(text)}`);
	}

	return { point, scale };
};

const containsPoint = (element: ScreenElement, point: Point): boolean =>
	point.x >= element.rect.x && point.x <= element.rect.x + element.rect.width &&
	point.y >= element.rect.y && point.y <= element.rect.y + element.rect.height;

// taller than a couple of lines of text is a card or an image, not a heading
const MAX_TEXT_ROW_HEIGHT = 80;

const overlapsRow = (a: ScreenElement, b: ScreenElement): boolean =>
	a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;

/**
 * Moves a vision hit from a heading to the control for it. Vision models point
 * at what a thing looks like, e.g. a "Watchlist" heading, while the tap belongs
 * to the control, e.g. the "See all" link on the same row.
 *
 * It only moves the point when all of these hold, and otherwise keeps the
 * model's point, which is usually right:
 * - the point is on a line of plain text, and not on anything tappable
 * - that text shares words with the query, so the model did point at it on purpose
 * - exactly one tappable element shares the row
 *
 * A point inside a tappable element is never moved. Overlays such as a
 * floating tab bar are often missing from the ui tree, so the element "under"
 * the point can be one the user cannot see or tap.
 */
export const snapToTappable = (point: Point, elements: ScreenElement[], query: string): ScreenElement | null => {
	const hits = elements.filter(element => containsPoint(element, point));
	if (hits.length === 0 || hits.some(isInteractive)) {
		return null;
	}

	const text = hits.find(element => element.rect.height <= MAX_TEXT_ROW_HEIGHT && scoreElement(element, query) > 0);
	if (!text) {
		return null;
	}

	const row = elements.filter(element => isInteractive(element) && overlapsRow(element, text));
	return row.length === 1 ? row[0] : null;
};

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | Array<{ type: string, text?: string }> } }>;
}

const replyText = (response: ChatResponse): string => {
	const content = response.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content.map(part => part.text ?? "").join("");
	}

	throw new ActionableError("The vision model returned an empty reply");
};

/** Sends the screenshot to an OpenAI-compatible vision model (Ollama, vLLM, LM Studio, OpenAI, Gemini, OpenRouter). */
export class VisionLocator implements Locator {
	public readonly name: string;
	public readonly usesTree = false;

	public constructor(private readonly config: VisionConfig) {
		this.name = `vision/${config.model}`;
	}

	public async locate(ctx: LocateContext, query: string): Promise<LocateOutcome> {
		const screenshot = await ctx.screenshot();
		const prompt = buildVisionPrompt(query);
		const response = await postJson<ChatResponse>(joinUrl(this.config.baseUrl, "chat/completions"), {
			model: this.config.model,
			temperature: 0,
			messages: [
				{ role: "system", content: prompt.system },
				{
					role: "user",
					content: [
						{ type: "text", text: prompt.user },
						{ type: "image_url", image_url: { url: `data:${screenshot.mimeType};base64,${screenshot.buffer.toString("base64")}` } },
					],
				},
			],
		}, { apiKey: this.config.apiKey, timeoutMs: this.config.timeoutMs });

		const parsed = parseVisionPoint(replyText(response), screenshot.size);
		if (parsed === null) {
			ctx.notes.push(`${this.name}: not found`);
			return null;
		}

		const point = imageToScreenPoint(parsed.point, screenshot.size, await ctx.screenSize());
		if (point === null) {
			throw new ActionableError("The screen size of this device is unknown, so a position on the screenshot cannot be turned into a tap position");
		}

		ctx.notes.push(`${this.name}: coordinates read as ${SCALE_LABEL[parsed.scale]}`);

		// the ui tree is only a hint here, a failure to read it keeps the model's point
		const elements = await ctx.elements().catch(() => []);
		const snapped = snapToTappable(point, elements, query);
		if (snapped) {
			ctx.notes.push(`snapped ${point.x},${point.y} to ${snapped.ref ?? "element"} on the same row`);
			return { point: elementCenter(snapped), ref: snapped.ref, confidence: 1, source: this.name };
		}

		return { point, confidence: 1, source: this.name };
	}
}
