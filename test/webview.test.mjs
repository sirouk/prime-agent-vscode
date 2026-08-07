/**
 * Webview DOM harness: drives the built media/main.js inside happy-dom with
 * the same host->webview messages SessionController sends.
 */

import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';
document.body.className = "vscode-dark";

const posted = [];
const vscodeApi = {
	postMessage: (m) => posted.push(m),
	getState: () => undefined,
	setState: () => {},
};

globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLAnchorElement = window.HTMLAnchorElement;
globalThis.SVGSVGElement = window.SVGSVGElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.FileReader = window.FileReader;
globalThis.Event = window.Event;
globalThis.acquireVsCodeApi = () => vscodeApi;
window.acquireVsCodeApi = () => vscodeApi;

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

function hostMessage(data) {
	window.dispatchEvent(new window.MessageEvent("message", { data }));
}

const code = fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
window.eval(code);

check("sends ready on boot", posted.some((m) => m.type === "ready"));
check("welcome screen visible", !!document.querySelector(".welcome"));

const baseStatus = {
	connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "chutes/kimi", thinkingLevel: "max", sessionName: "demo", sessionId: "019fd749-x",
	statsText: "", usageTotal: 4483, costUsd: 0.004,
	contextTokens: 60000, contextWindow: 262144, contextPercent: 23,
	modelProvider: "chutes", modelId: "kimi",
};

hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "hello there" },
		{
			role: "assistant", model: "kimi", stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "I will edit the file.\n\n- a\n- b\n\n```py\nprint(1)\n```" },
				{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 2;\nconst y = 3;" }] } },
				{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "npm run build" } },
			],
			usage: { totalTokens: 15, cost: { total: 0.01 } },
		},
		{ role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: "edited src/app.ts" }] },
		{ role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "done" }] },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "The answer is **4**." }] },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
	steerDefault: "steer",
});

const scroller = document.querySelector(".messages");
check("welcome removed after snapshot", !document.querySelector(".welcome"));
check("user bubble rendered", !!scroller.querySelector(".bubble-user"));
check("assistant avatar rendered", !!scroller.querySelector(".avatar svg"));
check("markdown list rendered", scroller.querySelectorAll(".md li").length === 2);
check("code block with header rendered", scroller.querySelectorAll(".codeblock").length === 1);
check("thinking block rendered", !!scroller.querySelector("details.thinking"));
check("edit diff lines rendered", scroller.querySelectorAll(".diff-line.del").length === 1 && scroller.querySelectorAll(".diff-line.add").length === 2,
	`${scroller.querySelectorAll(".diff-line").length} diff lines`);
check("edit path row rendered", !!scroller.querySelector(".tool-path"));
check("bash term prompt rendered", [...scroller.querySelectorAll(".term-prompt")].some((p) => p.textContent === "$ "));
check("tool pill shows done", [...scroller.querySelectorAll(".tool-pill")].some((p) => p.textContent === "done"));
check("usage line rendered", scroller.querySelectorAll(".usage-line").length >= 1);
check("hover copy actions exist", scroller.querySelectorAll(".row-actions").length >= 2);
check("session title shown", document.querySelector(".session-title").textContent === "demo");
check("live badge", document.querySelector(".live-label").textContent === "live");
check("context meter labeled", document.querySelector(".context-label").textContent.includes("262k"));

// --- model menu with favorites ---
hostMessage({
	type: "models",
	models: [
		{ provider: "chutes", id: "kimi", contextWindow: 262144, reasoning: true },
		{ provider: "chutes", id: "glm", contextWindow: 131072, reasoning: false },
		{ provider: "openai", id: "gpt-5", contextWindow: 400000, reasoning: true },
	],
});
hostMessage({ type: "favorites", favorites: [{ provider: "chutes", modelId: "kimi" }] });
const modelBtn = [...document.querySelectorAll(".rail-pill.model")][0];
modelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const dropdown = document.querySelector(".dropdown");
check("model menu opens", !!dropdown);
check("model menu has search", !!dropdown.querySelector(".dropdown-search"));
check("favorites section present", [...document.querySelectorAll(".dropdown-section")].some((s) => s.textContent === "Favorites"));
check("all model rows present", document.querySelectorAll(".dropdown-item").length === 3);
posted.length = 0;
// toggle favorite on the gpt-5 row
const gptRow = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("gpt-5"));
gptRow.querySelector(".dropdown-star").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("star posts toggle", posted.some((m) => m.type === "toggleFavoriteModel" && m.modelId === "gpt-5"));
// select a model row
const glmRow = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("glm"));
glmRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setModel", posted.some((m) => m.type === "setModel" && m.modelId === "glm"));
check("menu closed after select", !document.querySelector(".dropdown"));
// non-reasoning model disables the thinking pill
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm", thinkingLevel: "off" } });
check("thinking pill disabled for non-reasoning model", document.querySelector(".rail-pill.disabled-pill") !== null);

// --- thinking menu ---
hostMessage({ type: "status", status: { ...baseStatus } });
const thinkingBtn = [...document.querySelectorAll(".rail-pill.subtle")].find((b) => b.textContent.includes("thinking"));
thinkingBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tDrop = document.querySelector(".dropdown");
check("thinking menu opens", !!tDrop);
check("thinking levels offered", tDrop.querySelectorAll(".dropdown-item").length === 6);
posted.length = 0;
[...tDrop.querySelectorAll(".dropdown-item")].find((r) => r.textContent.startsWith("high")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setThinkingLevel", posted.some((m) => m.type === "setThinkingLevel" && m.level === "high"));

// --- composer send ---
posted.length = 0;
const textarea = document.querySelector("textarea");
textarea.value = "test prompt";
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const promptMsg = posted.find((m) => m.type === "prompt");
check("enter sends prompt", !!promptMsg && promptMsg.payload.text === "test prompt");

// --- history view (grouped) ---
posted.length = 0;
const historyBtn = [...document.querySelectorAll(".icon-btn")].find((b) => b.title === "Sessions in this workspace");
historyBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("requests history on toggle", posted.some((m) => m.type === "requestHistory"));
hostMessage({
	type: "history",
	sessions: [
		{ path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
check("history groups rendered", document.querySelectorAll(".history-item").length === 2);
check("other session shows folder", [...document.querySelectorAll(".history-item")].some((i) => i.textContent.includes("proj")));
posted.length = 0;
document.querySelectorAll(".history-item")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("resume switches session", posted.some((m) => m.type === "switchSession" && m.path === "/tmp/b.jsonl"));

console.log(failed === 0 ? "\nPASS webview harness" : `\n${failed} webview checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
