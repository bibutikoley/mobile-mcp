import { ScreenElement } from "../robot";
import { formatElements } from "../format-elements";
import { askSystemOne, ChoiceAnswer, NoulAnswer, SystemOneConfig } from "./systemone";
import { elementHit, LocateContext, LocateOutcome, Locator } from "./types";

export interface DecideConfig extends SystemOneConfig {
	minConfidence: number;
}

// a choice question takes at most 255 options, one is "none"
const MAX_OPTIONS = 254;

// nimble rejects bodies over 64 KiB; leave room for questions and json overhead
const MAX_STATE_BYTES = 48 * 1024;

const NONE = "none";

// gates on the "does any element do this" answer, measured against kev: real
// matches scored 0.69-0.92 (paraphrases included), absent elements 0.20-0.24
const PRESENT_MIN = 0.5;
const ABSENT_MAX = 0.4;

// when kev is sure the element exists, a weaker pick is still right: on cinevault
// it picked the correct element at 0.38-0.53 with present 0.77-0.90, and its one
// wrong pick scored 0.15 with present 0.66
const STRONG_PRESENT = 0.75;
const WEAK_CHOICE_MIN = 0.35;

const optionKey = (element: ScreenElement, index: number): string => element.ref ? element.ref.replace(/^@/, "") : `n${index + 1}`;

/** One line per candidate, keyed the way the choice options are, trimmed to fit the request limits. */
export const buildDecisionState = (elements: ScreenElement[]): { state: string, options: Map<string, ScreenElement> } => {
	const lines = formatElements(elements, "text", { compact: true }).split("\n").slice(1);
	const options = new Map<string, ScreenElement>();
	const kept: string[] = [];
	let bytes = 0;

	for (let i = 0; i < elements.length && options.size < MAX_OPTIONS; i++) {
		const key = optionKey(elements[i], i);
		// the line starts with the ref, which the key already says
		const line = `${key}: ${elements[i].ref ? lines[i].substring(elements[i].ref!.length + 1) : lines[i]}`;
		bytes += Buffer.byteLength(line) + 1;
		if (bytes > MAX_STATE_BYTES) {
			break;
		}

		kept.push(line);
		options.set(key, elements[i]);
	}

	return { state: `Elements on a mobile screen, one per line as key: type and attributes\n${kept.join("\n")}`, options };
};

/**
 * Asks a decision model (Kev or Nimble) which listed element the user
 * means. It reads text only, so it can rule an element out of the ui tree but
 * cannot see anything the tree is missing.
 */
export class DecisionLocator implements Locator {
	public readonly name: string;
	public readonly usesTree = true;

	public constructor(private readonly config: DecideConfig) {
		this.name = `decide/${config.model}`;
	}

	public async locate(ctx: LocateContext, query: string): Promise<LocateOutcome> {
		const elements = ctx.candidates ?? await ctx.elements();
		if (elements.length === 0) {
			return "none";
		}

		const { state, options } = buildDecisionState(elements);
		const criteria: Record<string, string | null> = Object.fromEntries([...options.keys()].map(key => [key, null]));
		criteria[NONE] = "None of the listed elements matches";

		const answers = await askSystemOne(this.config, {
			state,
			questions: {
				target: {
					type: "choice",
					instructions: `Which element is "${query}"? Answer with its key.`,
					criteria,
				},
				// asked by meaning: "is it listed" reads literally, and scored real
				// paraphrase matches ("log in" for "Sign in") as absent
				present: {
					type: "noul",
					instructions: `Does any listed element do what "${query}" describes, even if it is worded differently?`,
				},
			},
		});

		const target = answers.target as ChoiceAnswer;
		const present = (answers.present as NoulAnswer).noul;
		const probability = target.probabilities?.[target.choice] ?? target.confidence;
		ctx.notes.push(`${this.name}: ${target.choice} ${probability.toFixed(2)}, present ${present.toFixed(2)}`);

		if (present < ABSENT_MAX || (target.choice === NONE && probability >= this.config.minConfidence)) {
			return "none";
		}

		const element = options.get(target.choice);
		const confident = probability >= this.config.minConfidence && present >= PRESENT_MIN;
		const backedByPresence = probability >= WEAK_CHOICE_MIN && present >= STRONG_PRESENT;
		if (!element || !(confident || backedByPresence)) {
			return null;
		}

		return elementHit(element, Number(probability.toFixed(2)), this.name);
	}
}
