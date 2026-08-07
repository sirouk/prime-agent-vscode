/**
 * Webview DOM harness: loads the built media/main.js inside happy-dom and
 * drives it with the same host->webview messages SessionController sends.
 */

import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';

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

check("sends ready on boot", !!posted.some((m) => m.type === "ready"));
check("welcome screen visible", !!document.querySelector(".welcome"));
check("butterfly brand rendered", !!document.querySelector(".brand svg"));

const baseStatus = {
	connected: true,
	streaming: false,
	compacting: false,
	retrying: false,
	restoring: false,
	modelLabel: "chutes/kimi",
	thinkingLevel: "max",
	sessionName: "demo-session",
	sessionId: "019fd749-abcd-1234",
	statsText: "1k tokens",
	usageTotal: 4483,
	costUsd: 0.004,
	contextTokens: 60000,
	contextWindow: 262144,
	contextPercent: 23,
};

// --- snapshot with a full conversation ---
hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "hello there" },
		{
			role: "assistant",
			model: "kimi",
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "I will run code.\n\n- a\n- b\n\n```py\nprint(2+2)\n```" },
				{ type: "toolCall", id: "tc1", name: "ipython", arguments: { code: "print(2+2)" } },
			],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
		},
		{ role: "toolResult", toolCallId: "tc1", toolName: "ipython", content: [{ type: "text", text: "4" }], isError: false },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "The answer is **4**." }] },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
});

const scroller = document.querySelector(".messages");
check("welcome removed after snapshot", !document.querySelector(".welcome"));
check("user bubble rendered", !!scroller.querySelector(".bubble-user"));
check("assistant avatar rendered", !!scroller.querySelector(".avatar svg"));
check("markdown list rendered", scroller.querySelectorAll(".md li").length === 2);
check("code block with header rendered", scroller.querySelectorAll(".codeblock").length === 1);
check("codeblock copy button", !!scroller.querySelector(".codeblock-copy"));
check("thinking block rendered", !!scroller.querySelector("details.thinking"));
check("tool block rendered", !!scroller.querySelector(".tool"));
check("tool pill shows done", [...scroller.querySelectorAll(".tool-pill")].some((p) => p.textContent === "done"));
check("tool has result section", !!scroller.querySelector(".tool-result"));
check("usage line rendered", scroller.querySelectorAll(".usage-line").length >= 1);
check("bold rendered", [...scroller.querySelectorAll(".md strong")].some((s) => s.textContent === "4"));
check("session title shown", document.querySelector(".session-title").textContent === "demo-session");
check("live badge", document.querySelector(".live-label").textContent === "live");
check("context meter labeled", document.querySelector(".context-label").textContent.includes("262k"));

// --- streaming lifecycle ---
posted.length = 0;
hostMessage({ type: "event", event: { type: "agent_start" } });
check("working row appears", !!scroller.querySelector(".working-row"));
hostMessage({ type: "event", event: { type: "message_start", message: { role: "assistant", content: [] } } });
hostMessage({
	type: "event",
	event: {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "partial **bo" }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "bo" },
	},
});
check("streaming bubble content", scroller.textContent.includes("partial"));
hostMessage({
	type: "event",
	event: {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "partial **bold** done" }], usage: { totalTokens: 2 } },
	},
});
check("finalized strong tag", [...scroller.querySelectorAll(".md strong")].some((s) => s.textContent === "bold"));
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
check("working row removed", !scroller.querySelector(".working-row"));

// --- tool streaming ---
hostMessage({ type: "event", event: { type: "agent_start" } });
hostMessage({
	type: "event",
	event: {
		type: "message_end",
		message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tc9", name: "bash", arguments: { command: "ls" } }] },
	},
});
hostMessage({ type: "event", event: { type: "tool_execution_start", toolCallId: "tc9", toolName: "bash", args: { command: "ls" } } });
hostMessage({ type: "event", event: { type: "tool_execution_update", toolCallId: "tc9", toolName: "bash", args: {}, partialResult: { output: "file-a\n" } } });
check("partial tool output", scroller.textContent.includes("file-a"));
hostMessage({ type: "event", event: { type: "tool_execution_end", toolCallId: "tc9", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false } });
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });

// --- composer send ---
posted.length = 0;
const textarea = document.querySelector("textarea");
textarea.value = "test prompt";
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const promptMsg = posted.find((m) => m.type === "prompt");
check("enter sends prompt", !!promptMsg && promptMsg.payload.text === "test prompt");
check("composer cleared", textarea.value === "");

// --- history view ---
const historyBtn = [...document.querySelectorAll(".icon-btn")].find((b) => b.title === "Sessions in this workspace");
historyBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("requests history on toggle", posted.some((m) => m.type === "requestHistory"));
hostMessage({ type: "history", sessions: [{ path: "/tmp/s.jsonl", timestamp: new Date().toISOString(), name: "old chat" }] });
check("history item rendered", document.querySelectorAll(".history-item").length === 1);
posted.length = 0;
document.querySelector(".history-item").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("resume switches session", posted.some((m) => m.type === "switchSession" && m.path === "/tmp/s.jsonl"));

// --- changed files + notices ---
hostMessage({ type: "changedFiles", files: ["src/a.ts"] });
check("changed files bar", document.querySelector(".changed-files").classList.contains("visible"));
hostMessage({ type: "notice", level: "error", text: "boom" });
check("notice rendered", [...document.querySelectorAll(".notice")].some((n) => n.textContent.includes("boom")));

console.log(failed === 0 ? "\nPASS webview harness" : `\n${failed} webview checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
