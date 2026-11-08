import { ActionableError } from "../robot";
import { DecisionLocator, DecideConfig } from "./decide";
import { EmbeddingConfig, EmbeddingLocator } from "./embedding";
import { LexicalLocator } from "./lexical";
import { LocateContext, LocateResult, Locator } from "./types";
import { VisionConfig, VisionLocator } from "./vision";

export const STEP_NAMES = ["lexical", "embed", "decide", "vision"] as const;
export type StepName = typeof STEP_NAMES[number];

export interface LocatorConfig {
	chain: StepName[];
	timeoutMs: number;
	/** smaller mobile_list_elements_on_screen output; off keeps the original output */
	compactElements: boolean;
	/** include each step's decision in successful mobile_find_element replies, not only failed ones */
	trace: boolean;
	embed?: EmbeddingConfig;
	decide?: DecideConfig;
	vision?: VisionConfig;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string): string | undefined => {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
};

const flag = (env: Env, name: string): boolean | undefined => {
	const raw = value(env, name);
	if (raw === undefined) {
		return undefined;
	}

	if (raw === "1" || raw.toLowerCase() === "true") {
		return true;
	}

	if (raw === "0" || raw.toLowerCase() === "false") {
		return false;
	}

	throw new Error(`${name} must be 1 or 0, got "${raw}"`);
};

const positiveInt = (env: Env, name: string, fallback: number): number => {
	const raw = value(env, name);
	if (raw === undefined) {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	}

	return parsed;
};

const fraction = (env: Env, name: string, fallback: number): number => {
	const raw = value(env, name);
	if (raw === undefined) {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(`${name} must be a number between 0 and 1, got "${raw}"`);
	}

	return parsed;
};

// base url and model come as a pair: one without the other is a typo, not "off"
const endpoint = (env: Env, prefix: string): { baseUrl: string, model: string, apiKey?: string } | undefined => {
	const baseUrl = value(env, `${prefix}_BASE_URL`);
	const model = value(env, `${prefix}_MODEL`);
	if (baseUrl === undefined && model === undefined) {
		return undefined;
	}

	if (baseUrl === undefined || model === undefined) {
		throw new Error(`Set both ${prefix}_BASE_URL and ${prefix}_MODEL, or neither`);
	}

	if (!/^https?:\/\//i.test(baseUrl)) {
		throw new Error(`${prefix}_BASE_URL must start with http:// or https://, got "${baseUrl}"`);
	}

	return { baseUrl, model, apiKey: value(env, `${prefix}_API_KEY`) };
};

/** Reads the locator steps from MOBILEMCP_* env vars. Throws on invalid values so a typo fails at startup. */
export const readLocatorConfig = (env: Env = process.env): LocatorConfig => {
	const timeoutMs = positiveInt(env, "MOBILEMCP_LOCATOR_TIMEOUT_MS", 30000);
	const config: LocatorConfig = {
		chain: [],
		timeoutMs,
		compactElements: false,
		trace: flag(env, "MOBILEMCP_LOCATOR_TRACE") ?? false,
	};

	const embed = endpoint(env, "MOBILEMCP_EMBED");
	if (embed) {
		config.embed = {
			...embed,
			topK: positiveInt(env, "MOBILEMCP_EMBED_TOP_K", 32),
			// measured on embeddinggemma: real matches 0.72-0.84 leading by 0.04+, an absent element 0.67 by 0.01
			minScore: fraction(env, "MOBILEMCP_EMBED_MIN_SCORE", 0.7),
			minMargin: fraction(env, "MOBILEMCP_EMBED_MIN_MARGIN", 0.03),
			timeoutMs,
		};
	}

	const decide = endpoint(env, "MOBILEMCP_DECIDE");
	if (decide) {
		config.decide = { ...decide, minConfidence: fraction(env, "MOBILEMCP_DECIDE_MIN_CONFIDENCE", 0.6), timeoutMs };
	}

	const vision = endpoint(env, "MOBILEMCP_VISION");
	if (vision) {
		config.vision = { ...vision, timeoutMs };
	}

	// with nothing configured the element list stays as it always was; configuring
	// a model step means the user is after the savings, so compact comes with it
	const anyModel = config.embed !== undefined || config.decide !== undefined || config.vision !== undefined;
	config.compactElements = flag(env, "MOBILEMCP_COMPACT_ELEMENTS") ?? anyModel;

	const configured = (step: StepName): boolean => step === "lexical" || config[step] !== undefined;
	const requested = value(env, "MOBILEMCP_LOCATOR_CHAIN");
	if (requested === undefined) {
		config.chain = STEP_NAMES.filter(configured);
		return config;
	}

	for (const step of requested.split(",").map(name => name.trim()).filter(name => name !== "")) {
		if (!(STEP_NAMES as readonly string[]).includes(step)) {
			throw new Error(`MOBILEMCP_LOCATOR_CHAIN has an unknown step "${step}", use: ${STEP_NAMES.join(", ")}`);
		}

		if (!configured(step as StepName)) {
			throw new Error(`MOBILEMCP_LOCATOR_CHAIN includes "${step}" but it is not configured`);
		}

		if (!config.chain.includes(step as StepName)) {
			config.chain.push(step as StepName);
		}
	}

	if (config.chain.length === 0) {
		throw new Error("MOBILEMCP_LOCATOR_CHAIN is empty");
	}

	return config;
};

export const buildLocators = (config: LocatorConfig): Locator[] => {
	// with a decider later in the chain, embeddings only narrow the candidates
	const decideIndex = config.chain.indexOf("decide");
	return config.chain.map((step, index): Locator => {
		switch (step) {
			case "lexical": return new LexicalLocator();
			case "embed": return new EmbeddingLocator(config.embed!, decideIndex > index);
			case "decide": return new DecisionLocator(config.decide!);
			case "vision": return new VisionLocator(config.vision!);
		}
	});
};

/** Endpoints that configured steps send screenshots to. */
export const sendsScreenshots = (config: LocatorConfig): string[] =>
	config.chain.includes("vision") ? [config.vision!.baseUrl] : [];

export interface ChainOutcome {
	result: LocateResult | null;
	trace: string[];
}

/** Runs the steps in order and stops at the first one that locates the element. */
export const runChain = async (locators: Locator[], ctx: LocateContext, query: string): Promise<ChainOutcome> => {
	const trace: string[] = [];
	let notInTree = false;

	const flushNotes = () => {
		trace.push(...ctx.notes.splice(0));
	};

	for (const locator of locators) {
		if (notInTree && locator.usesTree) {
			trace.push(`${locator.name}: skipped, not in ui tree`);
			continue;
		}

		try {
			const outcome = await locator.locate(ctx, query);
			flushNotes();
			if (outcome === "none") {
				notInTree = true;
			} else if (outcome !== null) {
				return { result: outcome, trace };
			}
		} catch (err: any) {
			flushNotes();
			// a device failure is not a model failure, report it instead of trying the next model
			if (err instanceof ActionableError && /screen is most likely off|screenshot is invalid/i.test(err.message)) {
				throw err;
			}

			trace.push(`${locator.name}: failed, ${err.message}`);
		}
	}

	return { result: null, trace };
};
