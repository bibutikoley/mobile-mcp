import { Dimensions, ScreenElement } from "./robot";

export type ElementsFormat = "text" | "json";

const shortType = (type: string): string => type.substring(type.lastIndexOf(".") + 1);

// review text, legal copy and error stacks can run to tens of thousands of characters
const MAX_TEXT_LENGTH = 200;

const quote = (value: string): string => JSON.stringify(value);

const quoteCapped = (value: string): string => quote(value.length > MAX_TEXT_LENGTH
	? `${value.slice(0, MAX_TEXT_LENGTH)}…[+${value.length - MAX_TEXT_LENGTH} chars]`
	: value);

export interface FormatOptions {
	/** cap long strings and print a label or name once when it repeats the text; off keeps the original output */
	compact?: boolean;
}

const formatElementAsText = (element: ScreenElement, compact: boolean): string => {
	const q = compact ? quoteCapped : quote;
	const parts: string[] = [];
	if (element.ref) {
		parts.push(element.ref);
	}

	parts.push(shortType(element.type));

	if (element.text) {
		parts.push(`text=${q(element.text)}`);
	}

	// ios often repeats one string across text, label and name; compact prints it once
	if (element.label && !(compact && element.label === element.text)) {
		parts.push(`label=${q(element.label)}`);
	}

	if (element.name && !(compact && (element.name === element.label || element.name === element.text || element.name === element.identifier))) {
		parts.push(`name=${q(element.name)}`);
	}

	if (element.value) {
		parts.push(`value=${q(element.value)}`);
	}

	if (element.identifier) {
		parts.push(`id=${q(element.identifier)}`);
	}

	parts.push(`at=${element.rect.x},${element.rect.y}`);
	parts.push(`size=${element.rect.width}x${element.rect.height}`);

	// only emit non-default states, otherwise don't confuse llm
	if (element.focused) {
		parts.push("focused");
	}

	if (element.selected) {
		parts.push("selected");
	}

	if (element.checked) {
		parts.push("checked");
	}

	if (element.enabled === false) {
		parts.push("disabled");
	}

	return parts.join(" ");
};

const formatElementAsJson = (element: ScreenElement): any => {
	const out: any = {
		ref: element.ref,
		type: element.type,
		text: element.text,
		label: element.label,
		name: element.name,
		value: element.value,
		identifier: element.identifier,
		coordinates: {
			x: element.rect.x,
			y: element.rect.y,
			width: element.rect.width,
			height: element.rect.height,
		},
	};

	// only emit non-default states, otherwise don't confuse llm
	if (element.focused) {
		out.focused = true;
	}

	if (element.selected) {
		out.selected = true;
	}

	if (element.checked) {
		out.checked = true;
	}

	if (element.enabled === false) {
		out.enabled = false;
	}

	return out;
};

const TEXT_HEADER = "One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]";

export const formatElements = (elements: ScreenElement[], format: ElementsFormat, options: FormatOptions = {}): string => {
	if (format === "json") {
		return `Found these elements on screen: ${JSON.stringify(elements.map(formatElementAsJson))}`;
	}

	return [TEXT_HEADER, ...elements.map(element => formatElementAsText(element, options.compact === true))].join("\n");
};

// controls worth listing even without any text, label or id: they can still be tapped by ref
const INTERACTIVE_TYPE = /(Button|Switch|CheckBox|Checkbox|RadioButton|EditText|TextField|SecureTextField|SearchField|Slider|SeekBar|Toggle|Link|Stepper|Cell|Tab|MenuItem)$/;

export const isInteractive = (element: ScreenElement): boolean => INTERACTIVE_TYPE.test(shortType(element.type));

const hasContent = (element: ScreenElement): boolean =>
	!!(element.text || element.label || element.name || element.value || element.identifier);

const hasState = (element: ScreenElement): boolean =>
	!!(element.focused || element.selected || element.checked || element.enabled === false);

// an element mostly outside the viewport (a carousel card peeking in) is not worth listing
const MIN_VISIBLE_FRACTION = 0.3;

const visibleSpan = (start: number, length: number, limit: number): number =>
	Math.max(0, Math.min(start + length, limit) - Math.max(start, 0));

const isOnScreen = (element: ScreenElement, viewport?: Dimensions): boolean => {
	const { x, y, width, height } = element.rect;
	if (!(width > 0 && height > 0 && x + width > 0 && y + height > 0)) {
		return false;
	}

	if (!viewport) {
		return true;
	}

	return visibleSpan(x, width, viewport.width) >= MIN_VISIBLE_FRACTION * width &&
		visibleSpan(y, height, viewport.height) >= MIN_VISIBLE_FRACTION * height;
};

/**
 * The visible area in the current rotation. The reported screen size can be
 * the portrait one while the app is in landscape, so the rotation is taken
 * from the app's root node (origin 0,0, the screen size in either rotation).
 * Without a root to go by, both axes are bounded by the longer side, which
 * never hides anything visible.
 */
export const viewportOf = (elements: ScreenElement[], screen?: Dimensions): Dimensions | undefined => {
	if (!screen || screen.width <= 0 || screen.height <= 0) {
		return undefined;
	}

	const fits = (a: number, b: number) => Math.abs(a - b) <= 1;
	const root = elements.find(({ rect }) => rect.x === 0 && rect.y === 0 &&
		((fits(rect.width, screen.width) && fits(rect.height, screen.height)) || (fits(rect.width, screen.height) && fits(rect.height, screen.width))));
	if (root) {
		return { width: root.rect.width, height: root.rect.height };
	}

	const longest = Math.max(screen.width, screen.height);
	return { width: longest, height: longest };
};

const displayText = (element: ScreenElement): string =>
	[element.text, element.label, element.name, element.value].filter(Boolean).join("\u0000");

const overlapArea = (a: ScreenElement, b: ScreenElement): number =>
	Math.max(0, Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) - Math.max(a.rect.x, b.rect.x)) *
	Math.max(0, Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - Math.max(a.rect.y, b.rect.y));

const area = (element: ScreenElement): number => element.rect.width * element.rect.height;

// same words in (mostly) the same place: a labelled view and its static text, nested or side by side
const isSameThing = (a: ScreenElement, b: ScreenElement): boolean =>
	displayText(a) === displayText(b) && overlapArea(a, b) >= 0.5 * Math.min(area(a), area(b));

/**
 * Drops nodes that only cost tokens: layout containers without text, label,
 * id or state, nodes mostly outside the screen (carousels), and the second
 * copy of the same words in the same place (ios lists a labelled view and its
 * static text). Of two copies the tappable one is kept. Refs are untouched.
 */
export const pruneElements = (elements: ScreenElement[], screen?: Dimensions): ScreenElement[] => {
	const viewport = viewportOf(elements, screen);
	const kept: ScreenElement[] = [];
	for (const element of elements) {
		if (!isOnScreen(element, viewport) || !(hasContent(element) || hasState(element) || isInteractive(element))) {
			continue;
		}

		const twin = displayText(element) !== "" && !hasState(element)
			? kept.findIndex(other => !hasState(other) && isSameThing(other, element))
			: -1;
		if (twin === -1) {
			kept.push(element);
		} else if (isInteractive(element) && !isInteractive(kept[twin])) {
			kept[twin] = element;
		}
	}

	return kept;
};

const normalize = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

/** Searchable strings of an element, in the order a person would read them. */
export const elementTexts = (element: ScreenElement): string[] =>
	[element.text, element.label, element.name, element.value, element.identifier]
		.filter((value): value is string => !!value)
		.map(normalize);

/** Case- and accent-insensitive substring match against an element's text fields. */
export const matchesQuery = (element: ScreenElement, query: string): boolean => {
	const needle = normalize(query);
	return needle === "" || elementTexts(element).some(text => text.includes(needle));
};

export interface ElementsFilter {
	query?: string;
	all?: boolean;
	screen?: Dimensions;
}

export const filterElements = (elements: ScreenElement[], filter: ElementsFilter): ScreenElement[] => {
	const visible = filter.all ? elements : pruneElements(elements, filter.screen);
	return filter.query ? visible.filter(element => matchesQuery(element, filter.query!)) : visible;
};

export { normalize as normalizeText };
