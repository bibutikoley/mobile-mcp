import { ActionableError } from "../robot";

export interface PostJsonOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	timeoutMs: number;
}

const MAX_ERROR_BODY = 300;

/**
 * POSTs json and parses the json reply. Failures become ActionableErrors that
 * name the endpoint and status, never the api key or the request body (which
 * may carry a screenshot).
 */
export const postJson = async <T>(url: string, body: unknown, options: PostJsonOptions): Promise<T> => {
	const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
	if (options.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (err: any) {
		const reason = err?.name === "TimeoutError" ? `timed out after ${options.timeoutMs}ms` : (err?.cause?.message || err?.message || String(err));
		throw new ActionableError(`Request to ${url} failed: ${reason}`);
	}

	const text = await response.text();
	if (!response.ok) {
		throw new ActionableError(`Request to ${url} failed with HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY)}`);
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ActionableError(`Request to ${url} returned invalid JSON: ${text.slice(0, MAX_ERROR_BODY)}`);
	}
};

export const joinUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, "")}/${path}`;
