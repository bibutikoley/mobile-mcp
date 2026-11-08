import http from "node:http";
import { AddressInfo } from "node:net";

export interface RecordedRequest {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: any;
}

export type FakeHandler = (path: string, body: any) => { status?: number, json?: unknown, text?: string };

/** An http server on a free port that answers like an OpenAI-compatible or System One endpoint. */
export const startFakeModelServer = async (handler: FakeHandler) => {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => raw += chunk);
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : undefined;
			requests.push({ path: req.url ?? "", headers: req.headers, body });
			const reply = handler(req.url ?? "", body);
			res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
			res.end(reply.text ?? JSON.stringify(reply.json));
		});
	});

	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
};
