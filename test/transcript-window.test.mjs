/**
 * Transcript windowing + link-safety regressions, driven through the built
 * media/main.js in happy-dom.
 *
 * The windowing pair is the one that matters: `olderMessages` (never rendered)
 * and pruned rows (rendered, then trimmed) are INDEPENDENT, and the transcript
 * used to state only the first of them. With both live, "Load N earlier"
 * spliced old messages straight onto a tail that was missing hundreds in
 * between — a seam that reads as continuous history.
 */

import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';
document.body.className = "vscode-dark";

const posted = [];
const vscodeApi = { postMessage: (m) => posted.push(m), getState: () => undefined, setState: () => {} };
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

// Count capture-phase document listeners: a flyout that only unregisters on one
// of its close paths leaks one per open/close cycle for the panel's lifetime.
const realAdd = document.addEventListener.bind(document);
const realRemove = document.removeEventListener.bind(document);
let liveDocListeners = 0;
document.addEventListener = (...args) => { if (args[0] === "mousedown") liveDocListeners += 1; return realAdd(...args); };
document.removeEventListener = (...args) => { if (args[0] === "mousedown") liveDocListeners -= 1; return realRemove(...args); };

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const hostMessage = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

window.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));

const status = {
	connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "p/m", thinkingLevel: "off", statsText: "", sessionId: "s1",
};

// ---- windowing: both mechanisms live at once -------------------------------
const snapshot = [];
for (let i = 0; i < 400; i += 1) {
	snapshot.push({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `OLD${i}` }] });
}
hostMessage({ type: "snapshot", messages: snapshot, state: null, status });
const scroller = document.querySelector(".messages");
check("earlier bar reports the unrendered remainder", (document.querySelector(".earlier-count")?.textContent ?? "").includes("250"),
	document.querySelector(".earlier-count")?.textContent ?? "<none>");

for (let i = 0; i < 700; i += 1) {
	hostMessage({ type: "event", event: { type: "message_start", message: { role: "user", content: [{ type: "text", text: `NEW${i}` }] } } });
}
const gap = document.querySelector(".pruned-bar");
check("trimmed rows are announced even while the earlier bar is present", !!gap, gap?.textContent ?? "<none>");
check("the marker calls itself a gap, not a prefix", (gap?.textContent ?? "").startsWith("gap:"), (gap?.textContent ?? "").slice(0, 48));
const bar = document.querySelector(".earlier-bar:not(.pruned-bar)");
check("unrendered history sits above the trimmed gap", !!bar && !!gap && (bar.compareDocumentPosition(gap) & 4) !== 0);

document.querySelector(".earlier-load").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rows = [...scroller.children];
const gapIndex = rows.indexOf(document.querySelector(".pruned-bar"));
const texts = rows.map((row) => row.textContent ?? "");
const loadedAbove = texts.slice(0, gapIndex).filter((t) => t.includes("OLD")).length;
const loadedBelow = texts.slice(gapIndex).filter((t) => t.includes("OLD")).length;
check("loaded history lands above the gap, never spliced onto the tail", loadedAbove > 0 && loadedBelow === 0, `above=${loadedAbove} below=${loadedBelow}`);
check("the gap marker survives loading earlier messages", gapIndex >= 0);
const trimmed = Number(((document.querySelector(".pruned-bar")?.textContent ?? "").match(/(\d+) message/) ?? [])[1]);
check("the trimmed count excludes the chrome rows it lives next to", trimmed > 0 && trimmed % 100 === 2, String(trimmed));

// ---- the turn price belongs to the live tail, not to loaded history --------
hostMessage({
	type: "event",
	event: {
		type: "message_end",
		message: {
			role: "assistant", content: [{ type: "text", text: "reply" }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.5, total: 0.9 } },
		},
	},
});
const pricedRow = [...document.querySelectorAll(".user-footer")].filter((f) => (f.textContent ?? "").includes("input")).at(-1)?.parentElement;
check("the turn price lands on a recent row, not on loaded history", !(pricedRow?.textContent ?? "").includes("OLD"),
	(pricedRow?.textContent ?? "<none>").slice(0, 32));

// ---- links: what is rendered and what the host is asked to open must agree --
hostMessage({
	type: "snapshot",
	status, state: null,
	messages: [{
		role: "assistant",
		content: [{ type: "text", text: "[a](javascript:alert(1)) [b](http://example.com/x) [c](https://ok.example/y) [d](rel/path.md) [e](//evil.example/x)" }],
	}],
});
const anchors = [...document.querySelectorAll(".md a")];
const hrefs = anchors.map((a) => a.getAttribute("href"));
check("javascript: target is inert", hrefs[0] === "#", String(hrefs[0]));
check("relative target is inert (never resolved against the webview origin)", hrefs[3] === "#", String(hrefs[3]));
check("protocol-relative target is inert", hrefs[4] === "#", String(hrefs[4]));
check("http/https targets stay absolute", hrefs[1] === "http://example.com/x" && hrefs[2] === "https://ok.example/y", `${hrefs[1]} ${hrefs[2]}`);
posted.length = 0;
for (const anchor of anchors) anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const opened = posted.filter((m) => m.type === "openExternal").map((m) => m.url);
check("only allow-listed absolute URLs reach the host", JSON.stringify(opened) === JSON.stringify(["http://example.com/x", "https://ok.example/y"]), JSON.stringify(opened));

// ---- an unmatched delimiter must not make rendering quadratic --------------
const started = Date.now();
hostMessage({
	type: "snapshot",
	status, state: null,
	messages: [{ role: "assistant", content: [{ type: "text", text: "[a ".repeat(40_000) }] }],
});
const elapsed = Date.now() - started;
// Unbounded classes measured ~1.9 s here; the bounded pattern lands in tens of
// milliseconds. 400 ms separates the two without being flaky on a busy machine.
check("40k bare '[' render without a quadratic stall", elapsed < 400, `${elapsed}ms`);

// ---- the threshold flyout must free its outside-click listener -------------
hostMessage({ type: "status", status: { ...status, contextPercent: 42, contextWindow: 200_000, contextTokens: 84_000 } });
const gauge = document.querySelector(".context-meter");
const before = liveDocListeners;
for (let i = 0; i < 5; i += 1) {
	gauge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	gauge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}
await new Promise((resolve) => setTimeout(resolve, 10));
check("closing the threshold flyout by the gauge frees its document listener", liveDocListeners <= before, `before=${before} after=${liveDocListeners}`);

// ---- the host's own default percent must not be dropped --------------------
hostMessage({ type: "compactThreshold", percent: null, defaultPercent: 94 });
gauge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("the default percent sent WITH the threshold message is used", (document.querySelector(".threshold-flyout")?.textContent ?? "").includes("94"),
	(document.querySelector(".threshold-flyout")?.textContent ?? "").slice(0, 48));

// ---- observing a session must not suppress later spawn cards ---------------
const spawn = { activeSessionId: "child-1", browseRef: "ref-1", name: "kid", created: new Date().toISOString() };
hostMessage({ type: "snapshot", messages: [], state: null, status });
hostMessage({ type: "sessionChildren", children: [], spawned: [spawn] });
const firstCards = document.querySelectorAll(".spawned-card").length;
hostMessage({ type: "observedSession", sessionId: "other", messages: [] });
hostMessage({ type: "sessionChildren", children: [], spawned: [spawn] });
check("spawn cards come back after an observed session", document.querySelectorAll(".spawned-card").length >= 1,
	`before=${firstCards} after=${document.querySelectorAll(".spawned-card").length}`);

console.log(failed === 0 ? "\nPASS transcript-window" : `\nFAIL transcript-window (${failed})`);
process.exit(failed === 0 ? 0 : 1);
