import { ScreenElement } from "../robot";
import { elementTexts, normalizeText } from "../format-elements";
import { elementHit, LocateContext, LocateOutcome, Locator } from "./types";

export const LEXICAL_MIN_SCORE = 0.7;

const tokens = (value: string): string[] => value.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);

/** 1 for an exact match, less for a prefix, substring or partial word overlap, 0 for nothing in common. */
export const scoreText = (needle: string, text: string): number => {
	if (needle === "" || text === "") {
		return 0;
	}

	if (text === needle) {
		return 1;
	}

	const coverage = needle.length / text.length;
	if (text.startsWith(needle)) {
		return 0.7 + 0.25 * coverage;
	}

	if (text.includes(needle)) {
		return 0.6 + 0.3 * coverage;
	}

	const needleTokens = tokens(needle);
	const textTokens = new Set(tokens(text));
	const shared = needleTokens.filter(token => textTokens.has(token)).length;
	return needleTokens.length === 0 ? 0 : 0.5 * shared / needleTokens.length;
};

export const scoreElement = (element: ScreenElement, query: string): number => {
	const needle = normalizeText(query);
	return Math.max(0, ...elementTexts(element).map(text => scoreText(needle, text)));
};

/** Best-scoring element, preferring the earlier (usually outer, tappable) one on ties. */
export const bestLexicalMatch = (elements: ScreenElement[], query: string): { element: ScreenElement, score: number } | null => {
	let best: { element: ScreenElement, score: number } | null = null;
	for (const element of elements) {
		const score = scoreElement(element, query);
		if (score > 0 && (best === null || score > best.score)) {
			best = { element, score };
		}
	}

	return best;
};

export class LexicalLocator implements Locator {
	public readonly name = "lexical";
	public readonly usesTree = true;

	public constructor(private readonly minScore = LEXICAL_MIN_SCORE) {
	}

	public async locate(ctx: LocateContext, query: string): Promise<LocateOutcome> {
		const best = bestLexicalMatch(await ctx.elements(), query);
		if (best === null || best.score < this.minScore) {
			ctx.notes.push(`lexical: ${best ? `best ${best.score.toFixed(2)}` : "no match"}`);
			return null;
		}

		return elementHit(best.element, Number(best.score.toFixed(2)), this.name);
	}
}
