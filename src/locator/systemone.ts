import { joinUrl, postJson } from "./http";

/**
 * Client for the System One decision api, served for the open Kev and Nimble
 * models by Ollama at /v1/systemone. Text only.
 */
export interface SystemOneConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	timeoutMs: number;
}

export type SystemOneQuestion =
	| { type: "choice", instructions: string, criteria: Record<string, string | null> }
	| { type: "noul", instructions: string, criteria?: { true: string, false: string } };

export interface ChoiceAnswer { type: "choice", choice: string, confidence: number, probabilities: Record<string, number> }
export interface NoulAnswer { type: "noul", noul: number }
export type SystemOneAnswer = ChoiceAnswer | NoulAnswer;

interface SystemOneResponse {
	model?: string;
	answers?: Record<string, SystemOneAnswer>;
}

export interface SystemOneRequest {
	state: string;
	questions: Record<string, SystemOneQuestion>;
}

export const askSystemOne = async (config: SystemOneConfig, request: SystemOneRequest): Promise<Record<string, SystemOneAnswer>> => {
	const body = {
		model: config.model,
		state: request.state,
		questions: request.questions,
	};

	const response = await postJson<SystemOneResponse>(joinUrl(config.baseUrl, "systemone"), body, {
		apiKey: config.apiKey,
		timeoutMs: config.timeoutMs,
	});

	if (!response.answers || typeof response.answers !== "object") {
		throw new Error(`System One model ${config.model} returned no answers`);
	}

	for (const id of Object.keys(request.questions)) {
		if (!response.answers[id]) {
			throw new Error(`System One model ${config.model} did not answer "${id}"`);
		}
	}

	return response.answers;
};
