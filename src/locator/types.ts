import { Dimensions, Robot, ScreenElement } from "../robot";
import { pruneElements } from "../format-elements";
import { captureScreenshot, CapturedScreenshot } from "../screenshot";

export interface Point {
	x: number;
	y: number;
}

export interface LocateResult {
	/** screen (tap) coordinates */
	point: Point;
	ref?: string;
	confidence: number;
	source: string;
}

/**
 * A located element, "none" when the step is confident the element is not in
 * the ui tree (later tree steps are skipped), or null when the step is unsure.
 */
export type LocateOutcome = LocateResult | "none" | null;

export interface Locator {
	name: string;
	/** reads the ui tree only; skipped once a step has answered "none" */
	usesTree: boolean;
	locate(ctx: LocateContext, query: string): Promise<LocateOutcome>;
}

// locators send screenshots to a model, which resizes anyway and answers in
// size-independent units; a smaller image is faster and the real size is read back
const LOCATOR_SCREENSHOT_MAX_SIZE = 1280;

/** Everything a locate call reads from the device, fetched at most once per call. */
export class LocateContext {
	/** set by the embedding step for the decision step */
	public candidates?: ScreenElement[];

	/** notes for the trace, e.g. "32 candidates" */
	public readonly notes: string[] = [];

	private elementsPromise?: Promise<ScreenElement[]>;
	private screenshotPromise?: Promise<CapturedScreenshot>;
	private screenSizePromise?: Promise<Dimensions>;

	public constructor(public readonly robot: Robot) {
	}

	public elements(): Promise<ScreenElement[]> {
		this.elementsPromise ??= Promise.all([
			this.robot.getElementsOnScreen(),
			// pruning works without a screen size, so a failure here must not fail the listing
			Promise.resolve().then(() => this.screenSize()).catch(() => undefined),
		]).then(([elements, screen]) => pruneElements(elements, screen));
		return this.elementsPromise;
	}

	public screenshot(): Promise<CapturedScreenshot> {
		this.screenshotPromise ??= captureScreenshot(this.robot, { format: "jpeg", quality: 80, maxSize: LOCATOR_SCREENSHOT_MAX_SIZE });
		return this.screenshotPromise;
	}

	public screenSize(): Promise<Dimensions> {
		this.screenSizePromise ??= this.robot.getScreenSize();
		return this.screenSizePromise;
	}
}

export const elementCenter = (element: ScreenElement): Point => ({
	x: Math.round(element.rect.x + element.rect.width / 2),
	y: Math.round(element.rect.y + element.rect.height / 2),
});

export const elementHit = (element: ScreenElement, confidence: number, source: string): LocateResult => ({
	point: elementCenter(element),
	ref: element.ref,
	confidence,
	source,
});
