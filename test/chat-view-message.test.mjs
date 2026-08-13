/** Focused runtime validation coverage for the webview-to-host boundary. */
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const outputDir = mkdtempSync(join(tmpdir(), "prime-agent-chat-view-"));
const bundlePath = join(outputDir, "chat-view.cjs");
const Module = require("node:module");
const originalLoad = Module._load;

try {
	await esbuild.build({
		entryPoints: [join(process.cwd(), "src/chat-view.ts")],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "node18",
		external: ["vscode"],
		outfile: bundlePath,
		logLevel: "silent",
	});
	Module._load = function (request, ...args) {
		if (request === "vscode") return {};
		return originalLoad.call(this, request, ...args);
	};
	const { parseWebviewMessage } = require(bundlePath);

	const prompt = {
		type: "prompt",
		payload: {
			text: "Review this image and selection",
			images: [{ data: "aGVsbG8=", mimeType: "image/png", name: "capture.png" }],
			selections: [{ path: "src/chat-view.ts", startLine: 10, endLine: 20, text: "const safe = true;", languageId: "typescript" }],
			streamingBehavior: "followUp",
			clientRequestId: "sidebar-1",
		},
		extra: "not forwarded",
	};
	const parsedPrompt = parseWebviewMessage(prompt);
	assert.deepEqual(parsedPrompt, {
		type: "prompt",
		payload: {
			text: "Review this image and selection",
			images: [{ data: "aGVsbG8=", mimeType: "image/png", name: "capture.png" }],
			selections: [{ path: "src/chat-view.ts", startLine: 10, endLine: 20, text: "const safe = true;", languageId: "typescript" }],
			streamingBehavior: "followUp",
			clientRequestId: "sidebar-1",
		},
	});
	prompt.payload.images[0].data = "Y2hhbmdlZA==";
	assert.equal(parsedPrompt.payload.images[0].data, "aGVsbG8=", "parser must copy nested payload data");

	assert.equal(parseWebviewMessage(null), undefined);
	assert.equal(parseWebviewMessage({ type: "unknown" }), undefined);
	assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, images: [{ data: "not base64", mimeType: "image/png" }] } }), undefined);
	assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, text: "x".repeat(200_001) } }), undefined);
	assert.equal(parseWebviewMessage({ type: "prompt", payload: { ...prompt.payload, selections: [{ ...prompt.payload.selections[0], startLine: 9, endLine: 8 }] } }), undefined);
	assert.equal(parseWebviewMessage({ type: "browseChild", browseRef: "../forged" }), undefined);
	assert.equal(parseWebviewMessage({ type: "switchSession", path: "/tmp/forged.jsonl" }), undefined);
	assert.equal(parseWebviewMessage({ type: "deleteSession", path: "/tmp/session\0.jsonl", sessionId: "safe-id" }), undefined);
	assert.equal(parseWebviewMessage({ type: "openFile", path: "src/app.ts", endLine: 4 }), undefined);
	assert.equal(parseWebviewMessage({ type: "searchFiles", query: "src", requestId: Number.NaN }), undefined);
	assert.equal(parseWebviewMessage({ type: "setCompactThreshold", percent: 19 }), undefined);
	assert.equal(parseWebviewMessage({ type: "setCompactThreshold", percent: 22.5 }), undefined);
	assert.deepEqual(parseWebviewMessage({ type: "setCompactThreshold", percent: 55 }), { type: "setCompactThreshold", percent: 55 });
	assert.deepEqual(parseWebviewMessage({ type: "renameSession", name: "" }), { type: "renameSession", name: "" });
	assert.deepEqual(parseWebviewMessage({ type: "browseChild", browseRef: "531d0ed5-3678-405e-9b8c-e9879bd9e552" }), {
		type: "browseChild",
		browseRef: "531d0ed5-3678-405e-9b8c-e9879bd9e552",
	});
	assert.deepEqual(parseWebviewMessage({ type: "switchSession", path: "/tmp/known.jsonl", sessionId: "known-session" }), {
		type: "switchSession",
		path: "/tmp/known.jsonl",
		sessionId: "known-session",
	});
	assert.equal(parseWebviewMessage({ type: "draftChanged", text: "stale draft" }), undefined);
	assert.deepEqual(parseWebviewMessage({ type: "draftChanged", text: "current draft", sessionId: "known-session" }), {
		type: "draftChanged",
		text: "current draft",
		sessionId: "known-session",
	});

	console.log("PASS chat-view webview message parser");
} finally {
	Module._load = originalLoad;
	rmSync(outputDir, { recursive: true, force: true });
}
