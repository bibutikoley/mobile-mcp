import { expect, test } from "@playwright/test";

import { filterElements, formatElements, pruneElements, viewportOf } from "../src/format-elements";
import { imageToScreenPoint } from "../src/coordinate-mapping";
import { Robot, ScreenElement } from "../src/robot";
import { bestLexicalMatch, LexicalLocator, scoreText } from "../src/locator/lexical";
import { cosine, EmbeddingLocator } from "../src/locator/embedding";
import { buildDecisionState, DecisionLocator } from "../src/locator/decide";
import { parseVisionPoint, resolveScale, snapToTappable } from "../src/locator/vision";
import { buildLocators, readLocatorConfig, runChain } from "../src/locator/chain";
import { LocateContext, Locator } from "../src/locator/types";
import { startFakeModelServer } from "./support/fake-model-server";

const el = (ref: string, type: string, fields: Partial<ScreenElement> = {}, rect = { x: 0, y: 0, width: 100, height: 50 }): ScreenElement =>
	({ ref, type, rect, ...fields });

const signIn = el("@e1", "android.widget.Button", { text: "Sign in" }, { x: 100, y: 200, width: 200, height: 60 });
const signInGoogle = el("@e2", "android.widget.Button", { text: "Sign in with Google" });
const email = el("@e3", "android.widget.EditText", { label: "Email address", identifier: "com.app:id/email" });
const container = el("@e4", "android.widget.FrameLayout");
const iconButton = el("@e5", "android.widget.ImageButton");
const offscreen = el("@e6", "android.widget.TextView", { text: "Footer" }, { x: 0, y: -200, width: 100, height: 50 });
const zeroSize = el("@e7", "android.widget.TextView", { text: "Hidden" }, { x: 10, y: 10, width: 0, height: 0 });
const selectedTab = el("@e8", "android.view.View", { selected: true });

const robotWith = (elements: ScreenElement[]): Robot => ({ getElementsOnScreen: async () => elements } as unknown as Robot);

test.describe("element list pruning", () => {
	test("drops empty containers, zero-size and off-screen nodes, keeps content, state and interactive controls", () => {
		const kept = pruneElements([signIn, container, iconButton, offscreen, zeroSize, selectedTab, email]);
		expect(kept.map(e => e.ref)).toEqual(["@e1", "@e5", "@e8", "@e3"]);
	});

	// cinevault's detail screen: 648 nodes, 610 of them in horizontal carousels off to the right
	test("drops nodes beyond the right or bottom edge of the screen", () => {
		const carousel = el("@e20", "XCUIElementTypeStaticText", { label: "Trailer 4" }, { x: 1400, y: 300, width: 200, height: 40 });
		const below = el("@e21", "XCUIElementTypeStaticText", { label: "Reviews" }, { x: 0, y: 2000, width: 200, height: 40 });
		const screen = { width: 402, height: 874 };
		expect(pruneElements([signIn, carousel, below], screen).map(e => e.ref)).toEqual(["@e1"]);
		// a portrait size reported while the app is in landscape must not hide the right half
		const landscapeRight = el("@e22", "Button", { text: "Play" }, { x: 700, y: 100, width: 80, height: 40 });
		expect(pruneElements([landscapeRight], screen).map(e => e.ref)).toEqual(["@e22"]);
	});

	test("drops text repeated by a node inside an element that already shows it", () => {
		const cell = el("@e30", "XCUIElementTypeOther", { label: "Dune: Part Two" }, { x: 0, y: 100, width: 400, height: 60 });
		const inner = el("@e31", "XCUIElementTypeStaticText", { label: "Dune: Part Two" }, { x: 10, y: 110, width: 200, height: 40 });
		const elsewhere = el("@e32", "XCUIElementTypeStaticText", { label: "Dune: Part Two" }, { x: 0, y: 500, width: 200, height: 40 });
		expect(pruneElements([cell, inner, elsewhere]).map(e => e.ref)).toEqual(["@e30", "@e32"]);
	});

	test("compact text format caps very long labels, the default does not", () => {
		const review = el("@e1", "XCUIElementTypeStaticText", { label: "a".repeat(13000) });
		const line = formatElements([review], "text", { compact: true }).split("\n")[1];
		expect(line.length).toBeLessThan(300);
		expect(line).toContain("…[+12800 chars]");
		expect(formatElements([review], "text").length).toBeGreaterThan(13000);
	});

	// second cinevault run: home's hero carousel cards at x=402 and x=804 on a 402-wide screen were still listed
	test("takes the rotation from the app's root node and drops cards mostly off to the right", () => {
		const root = el("@e0", "XCUIElementTypeApplication", { label: "CineVault" }, { x: 0, y: 0, width: 402, height: 874 });
		const hero = el("@e7", "XCUIElementTypeLink", { label: "Dune" }, { x: 0, y: 100, width: 402, height: 462 });
		const next = el("@e8", "XCUIElementTypeLink", { label: "Mickey 17" }, { x: 402, y: 100, width: 402, height: 462 });
		const peeking = el("@e9", "XCUIElementTypeLink", { label: "Trailer" }, { x: 350, y: 600, width: 300, height: 150 });
		const screen = { width: 402, height: 874 };
		expect(viewportOf([root, hero], screen)).toEqual({ width: 402, height: 874 });
		expect(pruneElements([root, hero, next, peeking], screen).map(e => e.ref)).toEqual(["@e0", "@e7"]);

		// in landscape the root is wide even when the reported size is portrait
		const landscapeRoot = el("@e0", "XCUIElementTypeApplication", { label: "CineVault" }, { x: 0, y: 0, width: 874, height: 402 });
		expect(viewportOf([landscapeRoot], screen)).toEqual({ width: 874, height: 402 });
		expect(pruneElements([landscapeRoot, next], screen).map(e => e.ref)).toEqual(["@e0", "@e8"]);
	});

	// second cinevault run: a youtube webview lists a link and its text side by side, not nested
	test("drops a side-by-side twin and keeps the tappable one", () => {
		const text = el("@e26", "XCUIElementTypeStaticText", { label: "Official Trailer" }, { x: 20, y: 300, width: 200, height: 40 });
		const link = el("@e25", "XCUIElementTypeLink", { label: "Official Trailer" }, { x: 22, y: 302, width: 200, height: 40 });
		expect(pruneElements([text, link]).map(e => e.ref)).toEqual(["@e25"]);
	});

	test("all keeps everything, query filters case and accent insensitively", () => {
		const elements = [signIn, signInGoogle, container, email, el("@e9", "Text", { text: "Café menu" })];
		expect(filterElements(elements, { all: true })).toHaveLength(5);
		expect(filterElements(elements, { query: "SIGN IN" }).map(e => e.ref)).toEqual(["@e1", "@e2"]);
		expect(filterElements(elements, { query: "cafe" }).map(e => e.ref)).toEqual(["@e9"]);
		expect(filterElements(elements, { query: "email" }).map(e => e.ref)).toEqual(["@e3"]);
	});

	test("compact text format prints a repeated label or name once, the default prints everything as before", () => {
		const ios = el("@e1", "XCUIElementTypeButton", { text: "Done", label: "Done", name: "Done" });
		expect(formatElements([ios], "text", { compact: true }).split("\n")[1]).toBe("@e1 XCUIElementTypeButton text=\"Done\" at=0,0 size=100x50");
		expect(formatElements([ios], "text").split("\n")[1]).toBe("@e1 XCUIElementTypeButton text=\"Done\" label=\"Done\" name=\"Done\" at=0,0 size=100x50");
	});
});

test.describe("lexical", () => {
	test("exact beats prefix beats substring beats word overlap", () => {
		expect(scoreText("sign in", "sign in")).toBe(1);
		expect(scoreText("sign in", "sign in with google")).toBeGreaterThan(scoreText("in with", "sign in with google"));
		expect(scoreText("in with", "sign in with google")).toBeGreaterThan(scoreText("google sign", "sign in with google"));
		expect(scoreText("checkout", "sign in")).toBe(0);
	});

	test("picks the exact element over a longer one and keeps its ref and centre", async () => {
		expect(bestLexicalMatch([signInGoogle, signIn], "sign in")?.element.ref).toBe("@e1");
		const result = await new LexicalLocator().locate(new LocateContext(robotWith([signInGoogle, signIn])), "Sign in");
		expect(result).toEqual({ point: { x: 200, y: 230 }, ref: "@e1", confidence: 1, source: "lexical" });
	});

	test("is unsure rather than wrong when nothing matches well", async () => {
		const ctx = new LocateContext(robotWith([signIn, email]));
		expect(await new LexicalLocator().locate(ctx, "proceed to payment")).toBeNull();
		expect(ctx.notes[0]).toContain("lexical");
	});
});

test.describe("coordinate conversion", () => {
	test("scales a downscaled screenshot back to screen coordinates", () => {
		expect(imageToScreenPoint({ x: 100, y: 200 }, { width: 540, height: 1200 }, { width: 1080, height: 2400 })).toEqual({ x: 200, y: 400 });
	});

	test("turns a portrait screen size to match a landscape screenshot", () => {
		expect(imageToScreenPoint({ x: 600, y: 270 }, { width: 1200, height: 540 }, { width: 1080, height: 2400 })).toEqual({ x: 1200, y: 540 });
	});

	test("refuses to guess without sizes", () => {
		expect(imageToScreenPoint({ x: 1, y: 1 }, { width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
	});
});

test.describe("vision reply parsing", () => {
	const image = { width: 500, height: 1000 };

	test("reads plain, fenced and wrapped json on the 0-1000 scale", () => {
		expect(parseVisionPoint("{\"found\":true,\"x\":500,\"y\":250,\"scale\":1000}", image)).toEqual({ point: { x: 250, y: 250 }, scale: "1000" });
		expect(parseVisionPoint("```json\n{\"found\": true, \"x\": 100, \"y\": 100}\n```", image)?.point).toEqual({ x: 50, y: 100 });
		expect(parseVisionPoint("Sure! The element is here: {\"x\": 1000, \"y\": 1000} hope that helps", image)?.point).toEqual({ x: 500, y: 1000 });
	});

	test("uses the centre of a bounding box", () => {
		expect(parseVisionPoint("{\"bbox\": [100, 200, 300, 400]}", image)?.point).toEqual({ x: 100, y: 300 });
	});

	test("reads <point> and (x, y) styles from grounding models", () => {
		expect(parseVisionPoint("<point>500 500</point>", image)?.point).toEqual({ x: 250, y: 500 });
		expect(parseVisionPoint("click(0.5, 0.25)", image)).toEqual({ point: { x: 250, y: 250 }, scale: "normalized" });
	});

	test("returns null when the model says it is not there", () => {
		expect(parseVisionPoint("{\"found\": false}", image)).toBeNull();
	});

	test("rejects garbage and out-of-range points, quoting the reply", () => {
		expect(() => parseVisionPoint("I cannot see a button", image)).toThrow(/I cannot see a button/);
		expect(() => parseVisionPoint("{\"x\": 900, \"y\": 1500, \"scale\": \"pixels\"}", image)).toThrow(/outside the screenshot/);
	});

	test("resolveScale: declared wins, then fractions, then pixels, else 0-1000", () => {
		expect(resolveScale([0.5, 0.5], 1000)).toBe("1000");
		expect(resolveScale([500, 500], "pixels")).toBe("pixels");
		expect(resolveScale([0.5, 0.25], undefined)).toBe("normalized");
		expect(resolveScale([400, 1800], undefined)).toBe("pixels");
		expect(resolveScale([400, 800], undefined)).toBe("1000");
		expect(resolveScale([0, 1], undefined)).toBe("1000");
	});
});

test.describe("snapping a vision hit to something tappable", () => {
	// cinevault's profile: vision pointed at the "Watchlist" heading, the tap belonged to the "See all" link
	const heading = el("@e7", "XCUIElementTypeStaticText", { label: "Watchlist" }, { x: 20, y: 316, width: 120, height: 24 });
	const seeAll = el("@e8", "XCUIElementTypeLink", { label: "See all watchlist items" }, { x: 350, y: 322, width: 40, height: 20 });
	const poster = el("@e9", "XCUIElementTypeImage", { label: "Dune poster" }, { x: 20, y: 400, width: 160, height: 240 });
	const play = el("@e10", "XCUIElementTypeButton", { label: "Play" }, { x: 200, y: 500, width: 80, height: 40 });

	test("a heading named in the query with a single tappable element in its row snaps to it", () => {
		expect(snapToTappable({ x: 79, y: 328 }, [heading, seeAll], "open my watchlist")).toBe(seeAll);
	});

	test("text the query does not mention is left alone", () => {
		expect(snapToTappable({ x: 79, y: 328 }, [heading, seeAll], "Home tab")).toBeNull();
	});

	// second cinevault run: the floating tab bar is not in the ui tree, so a correct tab hit
	// landed "inside" the poster or row behind it, and snapping moved the tap onto that
	test("a point inside a tappable element is never moved", () => {
		const posterLink = el("@e20", "XCUIElementTypeLink", { label: "The Dark Knight" }, { x: 20, y: 760, width: 344, height: 254 });
		expect(snapToTappable({ x: 241, y: 822 }, [posterLink], "Search")).toBeNull();
		expect(snapToTappable({ x: 368, y: 328 }, [heading, seeAll], "see all of my watchlist")).toBeNull();
	});

	test("a point on a picture or empty space is left alone", () => {
		expect(snapToTappable({ x: 100, y: 500 }, [poster, play], "Dune poster")).toBeNull();
		expect(snapToTappable({ x: 300, y: 50 }, [heading, seeAll], "watchlist")).toBeNull();
	});
});

test.describe("embedding step", () => {
	// a two-word vocabulary, enough to make "log in" closest to "Sign in"
	const vectorFor = (text: string): number[] => {
		const t = text.toLowerCase();
		return [t.includes("log in") || t.includes("sign in") ? 1 : 0, t.includes("email") ? 1 : 0, 0.1];
	};

	test("ranks by meaning, answers alone above the threshold, and caches seen elements", async () => {
		const fake = await startFakeModelServer((_path, body) => ({
			json: { data: body.input.map((text: string, index: number) => ({ index, embedding: vectorFor(text) })) },
		}));
		try {
			const locator = new EmbeddingLocator({ baseUrl: fake.baseUrl, model: "embeddinggemma", topK: 2, minScore: 0.6, minMargin: 0.03, timeoutMs: 5000 }, false);
			const ctx = new LocateContext(robotWith([email, signIn]));
			const result = await locator.locate(ctx, "log in");
			expect(result).toMatchObject({ ref: "@e1", source: "embed" });
			expect(ctx.candidates?.map(e => e.ref)).toEqual(["@e1", "@e3"]);
			expect(fake.requests[0].body.input[0]).toBe("task: search result | query: log in");
			expect(fake.requests[0].body.input[1]).toMatch(/^title: none \| text: EditText email address/);

			await locator.locate(new LocateContext(robotWith([email, signIn])), "log in");
			expect(fake.requests).toHaveLength(1);
		} finally {
			await fake.close();
		}
	});

	test("only narrows the candidates when a decider follows", async () => {
		const fake = await startFakeModelServer((_path, body) => ({
			json: { data: body.input.map((text: string, index: number) => ({ index, embedding: vectorFor(text) })) },
		}));
		try {
			const locator = new EmbeddingLocator({ baseUrl: fake.baseUrl, model: "nomic-embed-text", topK: 1, minScore: 0.1, minMargin: 0, timeoutMs: 5000 }, true);
			const ctx = new LocateContext(robotWith([email, signIn]));
			expect(await locator.locate(ctx, "log in")).toBeNull();
			expect(ctx.candidates?.map(e => e.ref)).toEqual(["@e1"]);
			expect(fake.requests[0].body.input[0]).toBe("log in");
		} finally {
			await fake.close();
		}
	});

	// embeddinggemma scored an absent "play video" 0.67 against "Back", just 0.01 ahead of the next element
	test("does not answer alone when the best score barely leads", async () => {
		const fake = await startFakeModelServer((_path, body) => ({
			json: { data: body.input.map((text: string, index: number) => ({ index, embedding: text.includes("query") ? [1, 1] : text.includes("Sign") ? [1, 0.9] : [1, 0.88] })) },
		}));
		try {
			const locator = new EmbeddingLocator({ baseUrl: fake.baseUrl, model: "embeddinggemma", topK: 2, minScore: 0.7, minMargin: 0.03, timeoutMs: 5000 }, false);
			const ctx = new LocateContext(robotWith([email, signIn]));
			expect(await locator.locate(ctx, "play video")).toBeNull();
			expect(ctx.notes[0]).toMatch(/embed: best 1\.00 by 0\.00/);
		} finally {
			await fake.close();
		}
	});

	test("cosine", () => {
		expect(cosine([1, 0], [1, 0])).toBe(1);
		expect(cosine([1, 0], [0, 1])).toBe(0);
		expect(cosine([0, 0], [1, 0])).toBe(0);
	});
});

test.describe("decision step (Kev / Nimble)", () => {
	const decideAgainst = async (answers: unknown) => {
		const fake = await startFakeModelServer(() => ({ json: { model: "kev:4b", answers } }));
		const locator = new DecisionLocator({ baseUrl: fake.baseUrl, model: "kev:4b", minConfidence: 0.6, timeoutMs: 5000 });
		const ctx = new LocateContext(robotWith([signIn, email]));
		try {
			return { outcome: await locator.locate(ctx, "proceed"), request: fake.requests[0] };
		} finally {
			await fake.close();
		}
	};

	test("sends the elements as state and their refs plus none as choice options", async () => {
		const { outcome, request } = await decideAgainst({
			target: { type: "choice", choice: "e1", confidence: 0.9, probabilities: { e1: 0.92, e3: 0.05, none: 0.03 } },
			present: { type: "noul", noul: 0.88 },
		});
		expect(outcome).toEqual({ point: { x: 200, y: 230 }, ref: "@e1", confidence: 0.92, source: "decide/kev:4b" });
		expect(request.path).toBe("/v1/systemone");
		expect(request.body.model).toBe("kev:4b");
		expect(request.body.state).toContain("e1: Button text=\"Sign in\"");
		expect(Object.keys(request.body.questions.target.criteria)).toEqual(["e1", "e3", "none"]);
		expect(request.body.questions.present.type).toBe("noul");
	});

	test("a confident none means the element is not in the tree", async () => {
		const { outcome } = await decideAgainst({
			target: { type: "choice", choice: "none", confidence: 0.9, probabilities: { e1: 0.02, e3: 0.02, none: 0.96 } },
			present: { type: "noul", noul: 0.05 },
		});
		expect(outcome).toBe("none");
	});

	// real kev answers for "log in" against a "Sign in" button and "play video" with no such element
	test("accepts a paraphrase match and rejects an absent element, as kev answered them", async () => {
		const hit = await decideAgainst({
			target: { type: "choice", choice: "e1", confidence: 0.8, probabilities: { e1: 0.83, e3: 0.09, none: 0.08 } },
			present: { type: "noul", noul: 0.8 },
		});
		expect(hit.outcome).toMatchObject({ ref: "@e1", confidence: 0.83 });
		expect(hit.request.body.questions.present.instructions).toContain("even if it is worded differently");

		const absent = await decideAgainst({
			target: { type: "choice", choice: "none", confidence: 0.3, probabilities: { e1: 0.26, e3: 0.26, none: 0.48 } },
			present: { type: "noul", noul: 0.24 },
		});
		expect(absent.outcome).toBe("none");
	});

	// kev's real answers on cinevault: right picks below 0.6 when sure the element exists, a wrong one at 0.15
	test("accepts a weaker pick when kev is sure the element exists", async () => {
		const textBox = await decideAgainst({
			target: { type: "choice", choice: "e3", confidence: 0.3, probabilities: { e1: 0.2, e3: 0.53, none: 0.27 } },
			present: { type: "noul", noul: 0.9 },
		});
		expect(textBox.outcome).toMatchObject({ ref: "@e3", confidence: 0.53 });

		const seeAll = await decideAgainst({
			target: { type: "choice", choice: "e1", confidence: 0.2, probabilities: { e1: 0.38, e3: 0.32, none: 0.3 } },
			present: { type: "noul", noul: 0.81 },
		});
		expect(seeAll.outcome).toMatchObject({ ref: "@e1" });

		const wrongHeading = await decideAgainst({
			target: { type: "choice", choice: "e1", confidence: 0.1, probabilities: { e1: 0.15, e3: 0.14, none: 0.71 } },
			present: { type: "noul", noul: 0.66 },
		});
		expect(wrongHeading.outcome).toBeNull();
	});

	test("a split decision is unsure", async () => {
		const { outcome } = await decideAgainst({
			target: { type: "choice", choice: "e1", confidence: 0.2, probabilities: { e1: 0.5, e3: 0.45, none: 0.05 } },
			present: { type: "noul", noul: 0.7 },
		});
		expect(outcome).toBeNull();
	});

	test("state stays under the request size limit and option count", () => {
		const many = Array.from({ length: 400 }, (_, i) => el(`@e${i}`, "Text", { text: "x".repeat(300) }));
		const { state, options } = buildDecisionState(many);
		expect(Buffer.byteLength(state)).toBeLessThan(64 * 1024);
		expect(options.size).toBeLessThanOrEqual(254);
	});
});

test.describe("config", () => {
	test("with nothing set only the lexical step runs and everything else stays as it was", () => {
		const config = readLocatorConfig({});
		expect(config.chain).toEqual(["lexical"]);
		expect(config.compactElements).toBe(false);
		expect(config.trace).toBe(false);
	});

	test("compact element lists come with any model step, and can be set either way", () => {
		const vision = { MOBILEMCP_VISION_BASE_URL: "http://localhost:11434/v1", MOBILEMCP_VISION_MODEL: "qwen3-vl" };
		expect(readLocatorConfig(vision).compactElements).toBe(true);
		expect(readLocatorConfig({ ...vision, MOBILEMCP_COMPACT_ELEMENTS: "0" }).compactElements).toBe(false);
		expect(readLocatorConfig({ MOBILEMCP_COMPACT_ELEMENTS: "1" }).compactElements).toBe(true);
		expect(() => readLocatorConfig({ MOBILEMCP_COMPACT_ELEMENTS: "yes" })).toThrow(/must be 1 or 0/);
	});

	test("configured steps join in the default order", () => {
		const config = readLocatorConfig({
			MOBILEMCP_VISION_BASE_URL: "http://localhost:11434/v1", MOBILEMCP_VISION_MODEL: "qwen2.5vl:7b",
			MOBILEMCP_DECIDE_BASE_URL: "http://localhost:11434/v1", MOBILEMCP_DECIDE_MODEL: "kev:4b",
			MOBILEMCP_EMBED_BASE_URL: "http://localhost:11434/v1", MOBILEMCP_EMBED_MODEL: "embeddinggemma",
		});
		expect(config.chain).toEqual(["lexical", "embed", "decide", "vision"]);
		expect(buildLocators(config).map(l => l.name)).toEqual(["lexical", "embed", "decide/kev:4b", "vision/qwen2.5vl:7b"]);
	});


	test("an explicit chain picks order and subset", () => {
		const config = readLocatorConfig({
			MOBILEMCP_VISION_BASE_URL: "http://localhost:11434/v1", MOBILEMCP_VISION_MODEL: "qwen2.5vl:7b",
			MOBILEMCP_LOCATOR_CHAIN: "vision, lexical",
		});
		expect(config.chain).toEqual(["vision", "lexical"]);
	});

	test("invalid settings fail loudly", () => {
		expect(() => readLocatorConfig({ MOBILEMCP_VISION_MODEL: "x" })).toThrow(/Set both MOBILEMCP_VISION_BASE_URL/);
		expect(() => readLocatorConfig({ MOBILEMCP_EMBED_BASE_URL: "localhost:11434", MOBILEMCP_EMBED_MODEL: "x" })).toThrow(/must start with http/);
		expect(() => readLocatorConfig({ MOBILEMCP_LOCATOR_TIMEOUT_MS: "-1" })).toThrow(/positive integer/);
		expect(() => readLocatorConfig({ MOBILEMCP_LOCATOR_CHAIN: "lexical,vision" })).toThrow(/"vision" but it is not configured/);
		expect(() => readLocatorConfig({ MOBILEMCP_LOCATOR_CHAIN: "magic" })).toThrow(/unknown step "magic"/);
		expect(() => readLocatorConfig({ MOBILEMCP_DECIDE_BASE_URL: "http://x", MOBILEMCP_DECIDE_MODEL: "kev", MOBILEMCP_DECIDE_MIN_CONFIDENCE: "2" })).toThrow(/between 0 and 1/);
		expect(() => readLocatorConfig({ MOBILEMCP_DECIDE_BASE_URL: "http://x", MOBILEMCP_DECIDE_MODEL: "kev", MOBILEMCP_LOCATOR_CHAIN: "lexical,vision" })).toThrow(/"vision" but it is not configured/);
	});
});

test.describe("chain", () => {
	const step = (name: string, usesTree: boolean, outcome: any, calls: string[]): Locator => ({
		name, usesTree,
		locate: async () => {
			calls.push(name);
			if (outcome instanceof Error) {
				throw outcome;
			}

			return outcome;
		},
	});
	const hit = { point: { x: 1, y: 2 }, confidence: 1, source: "b" };

	test("stops at the first confident step", async () => {
		const calls: string[] = [];
		const { result } = await runChain([step("a", true, null, calls), step("b", false, hit, calls), step("c", false, null, calls)], new LocateContext(robotWith([])), "q");
		expect(result).toBe(hit);
		expect(calls).toEqual(["a", "b"]);
	});

	test("none skips the remaining tree steps but not the image steps", async () => {
		const calls: string[] = [];
		const { result, trace } = await runChain([step("decide", true, "none", calls), step("embed", true, hit, calls), step("vision", false, hit, calls)], new LocateContext(robotWith([])), "q");
		expect(calls).toEqual(["decide", "vision"]);
		expect(result).toBe(hit);
		expect(trace).toContain("embed: skipped, not in ui tree");
	});

	test("a failing model is recorded and the next step runs", async () => {
		const calls: string[] = [];
		const { result, trace } = await runChain([step("vision", false, new Error("connect ECONNREFUSED"), calls), step("next", false, null, calls)], new LocateContext(robotWith([])), "q");
		expect(result).toBeNull();
		expect(calls).toEqual(["vision", "next"]);
		expect(trace).toContain("vision: failed, connect ECONNREFUSED");
	});
});
