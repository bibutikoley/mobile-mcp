import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../src/server";
import { Mobilecli } from "../src/mobilecli";
import { startFakeModelServer } from "./support/fake-model-server";

const DEVICE = "emulator-5554";

// test/fixtures/baseline.jpg is 96x64; the screen is reported 10x larger
const SCREENSHOT = fs.readFileSync(path.join(__dirname, "fixtures", "baseline.jpg"));
const SCREEN = { width: 960, height: 640, scale: 1 };

const ELEMENTS = [
	{ ref: "@e1", type: "android.widget.FrameLayout", rect: { x: 0, y: 0, width: 960, height: 640 } },
	{ ref: "@e2", type: "android.widget.Button", text: "Sign in", rect: { x: 100, y: 200, width: 200, height: 60 } },
	{ ref: "@e3", type: "android.widget.EditText", label: "Email address", rect: { x: 100, y: 100, width: 400, height: 60 } },
];

const originalExecuteCommand = Mobilecli.prototype.executeCommand;
const originalExecuteCommandBuffer = Mobilecli.prototype.executeCommandBuffer;
const LOCATOR_ENV = ["MOBILEMCP_VISION_BASE_URL", "MOBILEMCP_VISION_MODEL", "MOBILEMCP_VISION_API_KEY", "MOBILEMCP_DECIDE_BASE_URL", "MOBILEMCP_DECIDE_MODEL", "MOBILEMCP_DECIDE_API_KEY", "MOBILEMCP_LOCATOR_CHAIN", "MOBILEMCP_COMPACT_ELEMENTS", "MOBILEMCP_LOCATOR_TRACE"];

let commands: string[][];

test.beforeEach(() => {
	commands = [];
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	Mobilecli.prototype.executeCommand = function(args: string[]): string {
		commands.push(args);
		if (args[0] === "--version") {
			return "mobilecli version 1.0.18";
		}

		if (args[0] === "devices") {
			return JSON.stringify({ status: "ok", data: { devices: [{ id: DEVICE, name: "Pixel", platform: "android", type: "emulator", version: "15", state: "online" }] } });
		}

		if (args[0] === "dump" && args[1] === "ui") {
			return JSON.stringify({ status: "ok", data: { elements: ELEMENTS } });
		}

		if (args[0] === "device" && args[1] === "info") {
			return JSON.stringify({ status: "ok", data: { device: { id: DEVICE, name: "Pixel", platform: "android", type: "emulator", version: "15", state: "online", screenSize: SCREEN } } });
		}

		if (args[0] === "io" && args[1] === "tap") {
			return "";
		}

		throw new Error(`unexpected mobilecli command: ${args.join(" ")}`);
	};
	Mobilecli.prototype.executeCommandBuffer = function(args: string[]): Buffer {
		commands.push(args);
		if (args[0] === "screenshot") {
			return SCREENSHOT;
		}

		throw new Error(`unexpected mobilecli command: ${args.join(" ")}`);
	};
});

test.afterEach(() => {
	Mobilecli.prototype.executeCommand = originalExecuteCommand;
	Mobilecli.prototype.executeCommandBuffer = originalExecuteCommandBuffer;
	for (const name of LOCATOR_ENV) {
		delete process.env[name];
	}
});

const call = async (tool: string, args: Record<string, unknown>): Promise<{ text: string, isError: boolean, instructions?: string }> => {
	const server = createMcpServer();
	const client = new Client({ name: "find-element-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		const result: any = await client.callTool({ name: tool, arguments: { device: DEVICE, ...args } });
		// the elapsed time varies from run to run
		const text = (result.content[0].text as string).replace(/ in \d+\.\ds/, " in Ns");
		return { text, isError: !!result.isError, instructions: client.getInstructions() };
	} finally {
		await client.close();
	}
};

const taps = () => commands.filter(args => args[0] === "io" && args[1] === "tap").map(args => args[2]);

test("with no models configured, finds a labelled element in the ui tree and taps it by ref", async () => {
	const { text, instructions } = await call("mobile_find_element", { query: "sign in", tap: true });
	expect(text).toBe("Found \"sign in\" @e2 at 200,230 via lexical (1) and tapped it in Ns");
	expect(taps()).toEqual(["@e2"]);
	expect(commands.some(args => args[0] === "screenshot")).toBe(false);
	expect(instructions).not.toContain("send screenshots");
});

test("with no models configured, an element missing from the tree is reported, not guessed", async () => {
	const { text, isError } = await call("mobile_find_element", { query: "settings gear" });
	expect(isError).toBe(true);
	expect(text).toContain("Could not find \"settings gear\" on screen in Ns (lexical: no match)");
	expect(taps()).toEqual([]);
});

test("falls back to the vision model and maps its answer onto the screen", async () => {
	const fake = await startFakeModelServer(() => ({
		json: { choices: [{ message: { content: "```json\n{\"found\": true, \"x\": 750, \"y\": 500, \"scale\": 1000}\n```" } }] },
	}));
	process.env.MOBILEMCP_VISION_BASE_URL = fake.baseUrl;
	process.env.MOBILEMCP_VISION_MODEL = "qwen2.5vl:7b";
	process.env.MOBILEMCP_VISION_API_KEY = "local-key";
	process.env.MOBILEMCP_LOCATOR_TRACE = "1";
	try {
		const { text, instructions } = await call("mobile_find_element", { query: "settings gear", tap: true });
		expect(text).toBe("Found \"settings gear\" at 720,320 via vision/qwen2.5vl:7b (1) and tapped it in Ns (lexical: no match; vision/qwen2.5vl:7b: coordinates read as 0-1000)");
		expect(taps()).toEqual(["720,320"]);
		expect(instructions).toContain(`mobile_find_element may send screenshots to: ${fake.baseUrl}`);

		const request = fake.requests[0];
		expect(request.path).toBe("/v1/chat/completions");
		expect(request.headers.authorization).toBe("Bearer local-key");
		expect(request.body.model).toBe("qwen2.5vl:7b");
		expect(request.body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${SCREENSHOT.toString("base64")}`);
	} finally {
		await fake.close();
	}
});

test("a vision model that cannot see it, or is down, ends in a clear not-found", async () => {
	process.env.MOBILEMCP_VISION_BASE_URL = "http://127.0.0.1:9/v1";
	process.env.MOBILEMCP_VISION_MODEL = "qwen2.5vl:7b";
	process.env.MOBILEMCP_LOCATOR_CHAIN = "vision";
	const { text, isError } = await call("mobile_find_element", { query: "settings gear" });
	expect(isError).toBe(true);
	expect(text).toMatch(/Could not find "settings gear" on screen in Ns \(vision\/qwen2.5vl:7b: failed, Request to http:\/\/127.0.0.1:9\/v1\/chat\/completions failed/);
});

test("with nothing configured, list elements and the instructions are exactly as before", async () => {
	const { text, instructions } = await call("mobile_list_elements_on_screen", {});
	expect(text.split("\n").slice(1)).toEqual([
		"@e1 FrameLayout at=0,0 size=960x640",
		"@e2 Button text=\"Sign in\" at=100,200 size=200x60",
		"@e3 EditText label=\"Email address\" at=100,100 size=400x60",
	]);
	expect(instructions).toContain("Read the screen with mobile_list_elements_on_screen, not screenshots");
	expect(instructions).not.toContain("mobile_find_element");
	// no screen size lookup either
	expect(commands.some(args => args[0] === "device" && args[1] === "info")).toBe(false);
});

test("the trace is left out of a successful reply unless asked for", async () => {
	const { text } = await call("mobile_find_element", { query: "email address" });
	expect(text).toBe("Found \"email address\" @e3 at 300,130 via lexical (1) in Ns");
});

test("compact lists prune containers and filter by query", async () => {
	process.env.MOBILEMCP_COMPACT_ELEMENTS = "1";
	const all = await call("mobile_list_elements_on_screen", {});
	expect(all.text.split("\n").slice(1)).toEqual([
		"@e2 Button text=\"Sign in\" at=100,200 size=200x60",
		"@e3 EditText label=\"Email address\" at=100,100 size=400x60",
	]);

	const filtered = await call("mobile_list_elements_on_screen", { query: "email" });
	expect(filtered.text.split("\n").slice(1)).toEqual(["@e3 EditText label=\"Email address\" at=100,100 size=400x60"]);

	const unpruned = await call("mobile_list_elements_on_screen", { all: true });
	expect(unpruned.text.split("\n")).toHaveLength(4);

	const none = await call("mobile_list_elements_on_screen", { query: "checkout" });
	expect(none.text).toContain("No element matches \"checkout\"");
});
