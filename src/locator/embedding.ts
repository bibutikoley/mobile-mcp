import { ScreenElement } from "../robot";
import { elementTexts } from "../format-elements";
import { joinUrl, postJson } from "./http";
import { elementHit, LocateContext, LocateOutcome, Locator } from "./types";

export interface EmbeddingConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	topK: number;
	minScore: number;
	/** how far the best score must lead the second, embedding scores bunch together */
	minMargin: number;
	timeoutMs: number;
}

interface EmbeddingsResponse {
	data?: Array<{ embedding: number[], index: number }>;
}

const CACHE_LIMIT = 4000;

export const cosine = (a: number[], b: number[]): number => {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
};

const shortType = (type: string): string => type.substring(type.lastIndexOf(".") + 1);

export const elementDocument = (element: ScreenElement): string => [shortType(element.type), ...elementTexts(element)].join(" ");

/**
 * Ranks ui elements by meaning rather than spelling ("log in" finds "Sign in").
 * With a decision step after it, it only narrows the list to the top K; on its
 * own it answers when the best score clears the threshold.
 */
export class EmbeddingLocator implements Locator {
	public readonly name = "embed";
	public readonly usesTree = true;

	// vectors of element strings already seen; screens repeat a lot between calls
	private readonly cache = new Map<string, number[]>();

	public constructor(private readonly config: EmbeddingConfig, private readonly feedsDecider: boolean) {
	}

	// embeddinggemma is trained with these task prefixes, other models get plain text
	private formatQuery(query: string): string {
		return this.isGemma() ? `task: search result | query: ${query}` : query;
	}

	private formatDocument(document: string): string {
		return this.isGemma() ? `title: none | text: ${document}` : document;
	}

	private isGemma(): boolean {
		return this.config.model.toLowerCase().includes("embeddinggemma");
	}

	private remember(key: string, vector: number[]): void {
		if (this.cache.size >= CACHE_LIMIT) {
			this.cache.delete(this.cache.keys().next().value!);
		}

		this.cache.set(key, vector);
	}

	public async embed(inputs: string[]): Promise<number[][]> {
		const missing = [...new Set(inputs.filter(input => !this.cache.has(input)))];
		if (missing.length > 0) {
			const response = await postJson<EmbeddingsResponse>(joinUrl(this.config.baseUrl, "embeddings"), {
				model: this.config.model,
				input: missing,
			}, { apiKey: this.config.apiKey, timeoutMs: this.config.timeoutMs });

			const data = response.data;
			if (!Array.isArray(data) || data.length !== missing.length) {
				throw new Error(`embeddings endpoint returned ${Array.isArray(data) ? data.length : "no"} vectors for ${missing.length} inputs`);
			}

			for (const item of data) {
				this.remember(missing[item.index], item.embedding);
			}
		}

		return inputs.map(input => this.cache.get(input)!);
	}

	public async locate(ctx: LocateContext, query: string): Promise<LocateOutcome> {
		const elements = await ctx.elements();
		if (elements.length === 0) {
			return null;
		}

		// the query is not cached under the same key as a document, its prefix differs
		const documents = elements.map(element => this.formatDocument(elementDocument(element)));
		const [queryVector, ...vectors] = await this.embed([this.formatQuery(query), ...documents]);

		const ranked = elements
			.map((element, i) => ({ element, score: cosine(queryVector, vectors[i]) }))
			.sort((a, b) => b.score - a.score);

		ctx.candidates = ranked.slice(0, this.config.topK).map(entry => entry.element);
		const best = ranked[0];
		const margin = best.score - (ranked[1]?.score ?? 0);
		ctx.notes.push(`embed: best ${best.score.toFixed(2)} by ${margin.toFixed(2)}, ${ctx.candidates.length} candidates`);

		if (this.feedsDecider || best.score < this.config.minScore || margin < this.config.minMargin) {
			return null;
		}

		return elementHit(best.element, Number(best.score.toFixed(2)), this.name);
	}
}
