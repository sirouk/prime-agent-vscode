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

// --- #34: the connect experience. Until the FIRST live status the splash is the
// whole panel — that is what keeps the input box away from an operator whose
// agent isn't answering yet. Held by reference: retiring removes the node.
const splash = document.querySelector(".boot-splash");
check("boot splash covers the panel before any status", !!splash && !splash.className.includes("gone"), splash?.className ?? "<none>");
check("splash shows the Prime Agent mark and name",
	!!splash?.querySelector('svg[viewBox="0 0 178 178"]') && document.querySelector(".boot-splash-name")?.textContent === "Prime Agent");
check("splash says what it is waiting for", (document.querySelector(".boot-splash-sub")?.textContent ?? "").includes("connecting"),
	document.querySelector(".boot-splash-sub")?.textContent ?? "<none>");

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
				// Real shape: prime-agent's default active toolset is `ipython` alone, so a
				// shell run arrives as a %%bash cell, never as a tool named `bash`.
				{ type: "toolCall", id: "tc2", name: "ipython", arguments: { code: "%%bash\nset -euo pipefail\ncd /Users/chrisk/repo\nnpm run build" } },
				{ type: "toolCall", id: "tc3", name: "ipython", arguments: { code: "import os\nimport time\nsubprocess.run([\"git\", \"status\"])" } },
			],
			usage: { input: 4555, output: 348, totalTokens: 4903, cost: { input: 0.013665, output: 0.00522, total: 0.018885 } },
		},
		{ role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: "edited src/app.ts" }] },
		{ role: "toolResult", toolCallId: "tc2", toolName: "ipython", content: [{ type: "text", text: "done" }] },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "The answer is **4**." }] },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
	steerDefault: "steer",
});

const scroller = document.querySelector(".messages");
check("boot splash retires on the first connected status", splash.className.includes("gone"), splash.className);
check("welcome removed after snapshot", !document.querySelector(".welcome"));
check("user bubble rendered", !!scroller.querySelector(".bubble-user"));
check("assistant row has no avatar (full width)", !scroller.querySelector(".avatar svg") && !!scroller.querySelector(".row-assistant .row-body"));
check("markdown list rendered", scroller.querySelectorAll(".md li").length === 2);
check("code block with header rendered", scroller.querySelectorAll(".codeblock").length === 1);
check("thinking block rendered", !!scroller.querySelector("details.thinking"));
check("edit diff lines rendered", scroller.querySelectorAll(".diff-line.del").length === 1 && scroller.querySelectorAll(".diff-line.add").length === 2,
	`${scroller.querySelectorAll(".diff-line").length} diff lines`);
check("edit path row rendered", !!scroller.querySelector(".tool-path"));
check("bash term prompt rendered", [...scroller.querySelectorAll(".term-prompt")].some((p) => p.textContent === "$ "));
check("no busy done pill (dot conveys state)", [...scroller.querySelectorAll(".tool-pill")].every((p) => p.textContent !== "done"));
check("usage line rendered", scroller.querySelectorAll(".usage-line").length >= 1);
check("user footer with copy + fork", !!scroller.querySelector(".row-user .user-footer .uf-icon") && scroller.querySelectorAll(".row-user .user-footer .uf-icon").length === 2);

// --- #56/#20: an ipython %%bash cell is a SHELL card, summarised by what actually ran ---
const shellCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolKind === "shell");
const pyCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolKind === "python");
check("%%bash ipython cell is a shell card", !!shellCard && shellCard.dataset.toolName === "ipython",
	[...scroller.querySelectorAll(".tool")].map((t) => `${t.dataset.toolName}/${t.dataset.toolKind}`).join("|"));
check("shell summary shows the command, not the cd/set preamble",
	shellCard?.querySelector(".tool-summary")?.textContent === "npm build",
	shellCard?.querySelector(".tool-summary")?.textContent ?? "<none>");
check("shell section labeled shell, not python",
	shellCard?.querySelector(".tool-section-head span")?.textContent === "shell",
	shellCard?.querySelector(".tool-section-head span")?.textContent ?? "<none>");
check("shell input drops the %%bash magic line",
	!shellCard?.querySelector(".tool-section:not(.tool-result) pre")?.textContent?.includes("%%bash"),
	shellCard?.querySelector(".tool-section:not(.tool-result) pre")?.textContent ?? "<none>");
check("plain python cell stays a python card, summarised by its real work",
	!!pyCard && pyCard.querySelector(".tool-summary").textContent === "git status",
	pyCard?.querySelector(".tool-summary")?.textContent ?? "<none>");

// copy of a shell card fences as bash, without the decorative $ prompt
let clipboard = "";
Object.defineProperty(window.navigator, "clipboard", {
	configurable: true,
	get: () => ({ writeText: async (t) => { clipboard = t; } }),
});
shellCard.querySelector(".tool-copy-all").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 0));
check("shell copy uses a bash fence with the real script", clipboard.includes("```bash\nset -euo pipefail") && !clipboard.includes("$ "), JSON.stringify(clipboard));
check("shell copy carries the output too", clipboard.includes("done"), JSON.stringify(clipboard));

// #20: an edit card copies its diff, and its output exactly once
const editCard = [...scroller.querySelectorAll(".tool")].find((t) => t.dataset.toolName === "edit");
clipboard = "";
editCard.querySelector(".tool-copy-all").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 0));
check("edit copy includes the path and the hunks", clipboard.includes("src/app.ts") && clipboard.includes("```diff") && clipboard.includes("-const x = 1;") && clipboard.includes("+const y = 3;"), JSON.stringify(clipboard));
check("edit copy emits the output once, not twice", clipboard.split("edited src/app.ts").length - 1 === 1, JSON.stringify(clipboard));

// --- #23: the user turn shows a price, honestly labeled as the reply's input cost ---
const ufCost = scroller.querySelector(".row-user .user-footer .uf-cost");
check("user footer shows the metered turn input price", !!ufCost && ufCost.textContent === "$0.0137 input", ufCost?.textContent ?? "<none>");
check("price says it prices the reply's context, not the message", (ufCost?.title ?? "").includes("not each message"), ufCost?.title ?? "");
check("token count stays an honest estimate", scroller.querySelector(".row-user .uf-tokens").textContent.includes("(est.)"));

// --- #22: expanding a collapsed block keeps the selection and sweeps in what it revealed ---
const thinking = scroller.querySelector("details.thinking");
const summaryEl = thinking.querySelector("summary");
const prose = scroller.querySelector(".row-assistant .md");
const selRange = document.createRange();
selRange.setStart(summaryEl.firstChild, 0);
selRange.setEnd(prose.firstChild.firstChild ?? prose.firstChild, 1);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(selRange);
summaryEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
thinking.open = true;
thinking.dispatchEvent(new window.Event("toggle", { bubbles: true }));
const after = window.getSelection();
check("selection spanning a collapsed block survives expanding it",
	after.rangeCount === 1 && !after.getRangeAt(0).collapsed && after.getRangeAt(0).startContainer === summaryEl.firstChild,
	`ranges=${after.rangeCount} collapsed=${after.rangeCount ? after.getRangeAt(0).collapsed : "n/a"}`);
// ...and a selection that ENDED inside the collapsed block extends over the text
// the expand just revealed, so the operator never re-selects (#22).
thinking.open = false;
const inner = document.createRange();
inner.setStart(summaryEl.firstChild, 0);
inner.setEnd(summaryEl.firstChild, 7);
sel.removeAllRanges();
sel.addRange(inner);
summaryEl.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
thinking.open = true;
thinking.dispatchEvent(new window.Event("toggle", { bubbles: true }));
const swept = window.getSelection().getRangeAt(0);
check("expanding sweeps the selection over the revealed thinking text",
	thinking.querySelector(".thinking-body").contains(swept.endContainer),
	`end=${swept.endContainer.nodeValue ?? swept.endContainer.nodeName}`);
check("session title shown", document.querySelector(".session-title").textContent === "demo");
check("live badge", document.querySelector(".live-label").textContent === "live");
check("context meter labeled", document.querySelector(".context-label").textContent.includes("262k"));

// --- model menu with favorites ---
hostMessage({
	type: "models",
	models: [
		{ provider: "chutes", id: "kimi", contextWindow: 262144, reasoning: true, input: ["text", "image"] },
		{ provider: "chutes", id: "glm", contextWindow: 131072, reasoning: false, input: ["text"] },
		{ provider: "openai", id: "gpt-5", contextWindow: 400000, reasoning: true, input: ["text", "image"] },
	],
});
hostMessage({ type: "favorites", favorites: [{ provider: "chutes", modelId: "kimi" }] });
const modelBtn = [...document.querySelectorAll(".rail-pill.model")][0];
modelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const dropdown = document.querySelector(".dropdown");
check("model menu opens", !!dropdown);
check("model menu has search", !!dropdown.querySelector(".dropdown-search"));
check("favorites section present", [...document.querySelectorAll(".dropdown-section")].some((s) => s.textContent === "Favorites"));
check("model menu items only (no thinking section)", document.querySelectorAll(".dropdown-item").length === 3,
	`${document.querySelectorAll(".dropdown-item").length} items`);
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
// brain is its own rail pill right of the model pill
const brainPill = document.querySelector(".composer-rail .rail-pill.brain");
check("brain rail pill present", !!brainPill);
// non-reasoning model: brain pill disabled, and model rows have no per-row accessories beyond the star
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm", thinkingLevel: "off" } });
check("brain pill disabled on non-reasoning model", document.querySelector(".composer-rail .rail-pill.brain").className.includes("disabled-pill"));
modelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const glmRowAcc = [...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("glm"));
check("no brain accessory on model rows", glmRowAcc && !glmRowAcc.querySelector(".dropdown-brain"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
// reasoning model: the brain pill lists exactly what the model declares. Kimi K3 TEE's
// real thinkingLevelMap maps every level to null except "max" — the host derives that
// and the menu must show "max" as its own row and never invent "xhigh".
const kimiLevels = { ...baseStatus, availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"] };
hostMessage({ type: "status", status: kimiLevels });
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" }, status: kimiLevels });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tDrop = document.querySelector(".dropdown");
check("thinking menu opens from brain pill", !!tDrop && (tDrop.querySelector(".dropdown-header")?.textContent ?? "").startsWith("Thinking —"));
const tLevels = [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("max listed as its own level, xhigh not invented", tLevels.some((l) => l.startsWith("max")) && !tLevels.some((l) => l.startsWith("xhigh")), JSON.stringify(tLevels));
check("current level marked (max, unaliased)", [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].some((r) => r.className.includes("current") && r.textContent.startsWith("max")));
posted.length = 0;
[...tDrop.querySelectorAll(".dropdown-item")].find((r) => r.textContent.startsWith("high")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setThinkingLevel", posted.some((m) => m.type === "setThinkingLevel" && m.level === "high"));
// available-levels feed filters the list
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: ["off", "medium", "high"] } });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const treatedLevels = [...(document.querySelector(".dropdown")?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("available levels filter the picker", treatedLevels.length === 3 && treatedLevels.every((l) => ["off", "medium", "high"].some((a) => l.startsWith(a))), JSON.stringify(treatedLevels));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
// unknown model (no list from the host): fall back to the levels every reasoning model
// takes — never xhigh/max, which exist only where the model declares them.
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: null } });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const fallbackLevels = [...(document.querySelector(".dropdown")?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("unknown model never offers xhigh/max", fallbackLevels.length === 5 && !fallbackLevels.some((l) => l.startsWith("xhigh") || l.startsWith("max")), JSON.stringify(fallbackLevels));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

// --- unified attach menu (vision-gated image item on a text model) ---
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
const attachBtn = [...document.querySelectorAll(".composer-rail .icon-btn")].find((b) => b.title.startsWith("Attach"));
attachBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const attachMenu = document.querySelector(".dropdown");
check("attach menu opens", !!attachMenu);
const imageItem = [...attachMenu.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("Image"));
check("image item disabled on text-only model", imageItem.className.includes("disabled"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

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
		{ path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true, id: "hist-a", sessionId: "019fd749-a" },
		{ path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
hostMessage({
	type: "history",
	sessions: [
		{ path: "/tmp/old.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 86_400e3 * 3).toISOString(), modifiedMs: Date.now() - 86_400e3 * 3, name: "oldest", inWorkspace: true },
		{ path: "/tmp/new.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 86_400e3).toISOString(), modifiedMs: Date.now() - 86_400e3, name: "renamed-just-now", inWorkspace: true },
		{ path: "/tmp/mid.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "newest", inWorkspace: true },
	],
});
const itemNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("history sorted recent-descending within bucket", itemNames[0] === "newest" && itemNames[1] === "renamed-just-now" && itemNames[2] === "oldest", itemNames.join("|"));
const relativeTimes = [...document.querySelectorAll(".history-item .history-item-time")].map((n) => n.textContent);
check("renamed session labels by activity time", relativeTimes[1].includes("d"), JSON.stringify(relativeTimes));
check("history groups rendered", document.querySelectorAll(".history-item").length === 3);
 // re-seed the canonical 2-item list for downstream checks
hostMessage({
	type: "history",
	sessions: [
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "hist-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
check("other session shows folder", [...document.querySelectorAll(".history-item")].some((i) => i.textContent.includes("proj")));
posted.length = 0;
document.querySelectorAll(".history-item")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("resume switches session", posted.some((m) => m.type === "switchSession" && m.path === "/tmp/b.jsonl"));

// --- subagents strip: renders children, browses into one, returns via parent ---
check("subagents strip hidden with no children", !document.querySelector(".subagents-strip.visible"));
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "019fdaa1-0000", activeSessionId: "abcdef123450", name: "verify-threads", runtimeKind: "subagent", rlmDepth: 1, isStreaming: true, attachedClients: 0 },
		{ id: "019fdaa2-0001", activeSessionId: "abcdef123451", name: "audit-style", runtimeKind: "subagent", rlmDepth: 1, isStreaming: false, attachedClients: 1 },
	],
});
check("subagents strip visible with children", !!document.querySelector(".subagents-strip.visible"));
const stripHeader = document.querySelector(".subagents-strip .subagents-header");
check("strip header shows count", stripHeader && stripHeader.textContent.includes("Subagents (2)"), stripHeader?.textContent ?? "");
stripHeader.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rows = document.querySelectorAll(".subagents-strip .subagent-row");
check("two subagent rows", rows.length === 2);
check("active badge on streaming child", [...rows].some((r) => r.querySelector(".subagent-badge")?.textContent === "active"));
posted.length = 0;
[...rows].find((r) => r.textContent.includes("verify-threads")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("browse posts browseChild", posted.some((m) => m.type === "browseChild" && m.activeSessionId === "abcdef123450"));
// host confirms the browse with a parent context: back-row appears and is clickable.
// The viewed subagent stays in the list — leaving it out is what made the count
// drop by one and left the green "viewing" highlight with nothing to land on.
hostMessage({
	type: "sessionChildren",
	children: [],
	parent: { id: "019fd749-root", activeSessionId: "019fd749main", name: "parent-agent" },
	siblings: [
		{ id: "019fdaa1-0000", activeSessionId: "abcdef123450", name: "verify-threads", runtimeKind: "subagent", rlmDepth: 1, status: "running", isStreaming: true, attachedClients: 1 },
		{ id: "019fdaa2-0001", activeSessionId: "abcdef123451", name: "audit-style", runtimeKind: "subagent", rlmDepth: 1, status: "idle", isStreaming: false, attachedClients: 1 },
	],
	viewedActiveSessionId: "abcdef123450",
});
const backRow = document.querySelector(".subagents-strip .subagents-back-row");
check("back-row appears while viewing a child", !!backRow, document.querySelector(".subagents-strip")?.textContent?.slice(0, 60) ?? "");
check("sibling section keeps every child of the parent", [...document.querySelectorAll(".subagents-list.siblings .subagent-row")].length === 2);
const viewingRow = document.querySelector(".subagent-row.viewing");
check("viewed child is highlighted", !!viewingRow && viewingRow.textContent.includes("verify-threads"), viewingRow?.textContent ?? "none");
check("count does not drop on entering a child", document.querySelector(".subagents-header").textContent.includes("Subagents (2)"), document.querySelector(".subagents-header").textContent);
// historical (finished, non-resident) subagents: separate collapsed group, not counted as live
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "live-1", activeSessionId: "aaaa0001", name: "shell-adapter", runtimeKind: "subagent", rlmDepth: 1, status: "idle", isStreaming: false, attachedClients: 0 },
		{ id: "done-1", activeSessionId: "019fd742-done1", name: "verify-vault", runtimeKind: "subagent", rlmDepth: 1, status: "inactive", isStreaming: false, attachedClients: 0 },
		{ id: "done-2", activeSessionId: "019fd742-done2", name: "verify-shell", runtimeKind: "subagent", rlmDepth: 1, status: "inactive", isStreaming: false, attachedClients: 0 },
	],
	parent: { id: "019fd749-root", activeSessionId: "019fd749main", name: "parent-agent" },
});
check("header separates live from finished", document.querySelector(".subagents-header").textContent.includes("Subagents (1 live · 2 finished)"), document.querySelector(".subagents-header").textContent);
check("live list holds only the resident subagent", document.querySelectorAll(".subagents-list:not(.historical) .subagent-row").length === 1);
check("historical group is collapsed by default", !document.querySelector(".subagents-list.historical"));
const histHead = document.querySelector(".subagents-subhead");
check("historical group has its own toggle", !!histHead && histHead.textContent.includes("Historical (2)"), histHead?.textContent ?? "none");
histHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("expanding historical reveals the finished rows", document.querySelectorAll(".subagents-list.historical .subagent-row").length === 2);
check("finished rows read finished, not idle", [...document.querySelectorAll(".subagents-list.historical .subagent-badge")].every((b) => b.textContent === "finished"));
histHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
posted.length = 0;
document.querySelector(".subagents-strip .subagents-back-row").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("back-row click posts backToParent", posted.some((m) => m.type === "backToParent"));

// --- #34: once connected the splash is done for good. A dropout mid-conversation
// may only move the status strip — a butterfly fading back over a live transcript
// is exactly what the operator ruled out.
hostMessage({ type: "status", status: { ...baseStatus, connected: true, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
hostMessage({ type: "status", status: { ...baseStatus, connected: false } });
check("a later disconnect does not re-fade the splash",
	splash.className.includes("gone") && ![...document.querySelectorAll(".boot-splash")].some((s) => !s.className.includes("gone")),
	splash.className);
check("the dropout is told in the status strip instead", document.querySelector(".live-label").textContent === "offline", document.querySelector(".live-label").textContent);
hostMessage({ type: "status", status: { ...baseStatus, connected: true, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });

// --- send button muted until content ---
const sendBtn = document.querySelector(".composer-dock .send-btn:not(.stop)");
check("send muted while empty", sendBtn.className.includes("muted"));
textarea.value = "something";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("send armed with input", !document.querySelector(".composer-dock .send-btn:not(.stop)").className.includes("muted"));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("send muted again after send", document.querySelector(".composer-dock .send-btn:not(.stop)").className.includes("muted"));

// --- history: stateful refresh + search filter ---
posted.length = 0;
document.querySelector(".history-search").value = "proj";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
const visibleItems = document.querySelectorAll(".history-item");
check("history search filters", visibleItems.length === 1 && visibleItems[0].textContent.includes("proj"));
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
check("search cleared restores both groups", document.querySelectorAll(".history-item").length === 2);

// --- context meter: gear + flyout state wording ---
const meter = document.querySelector(".context-meter");
meter.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const flyout = document.querySelector(".threshold-flyout");
check("threshold flyout opens", !!flyout && flyout.className.includes("visible"));
hostMessage({ type: "status", status: { ...baseStatus, compactDefaultPercent: 94 } });
check("flyout shows default state", flyout.querySelector(".threshold-title").textContent.includes("Agent auto-compact"), flyout.querySelector(".threshold-title").textContent);
check("flyout value shows pct + tokens", flyout.querySelector(".threshold-value").textContent.includes("94% · 246k"), flyout.querySelector(".threshold-value").textContent);
const tSlider = flyout.querySelector(".threshold-slider");
check("slider reaches the agent default instead of clamping to 80", tSlider.max === "94" && tSlider.value === "94", `max=${tSlider.max} value=${tSlider.value}`);
// #20: "max 80% reduction" is the floor — a slider that goes below 20% of the
// original context length is offering a compaction the agent will not honour.
check("slider floors at 20% of the original context", tSlider.min === "20" && tSlider.step === "5", `min=${tSlider.min} step=${tSlider.step}`);
// #35: the tick marks the real threshold, and moves when the session overrides it.
const tickDefault = meter.querySelector(".context-tick");
check("threshold tick sits at the agent default", !!tickDefault && tickDefault.style.left === "94%" && !tickDefault.className.includes("override"),
	`${tickDefault?.style.left ?? "<none>"} ${tickDefault?.className ?? ""}`);
check("default tick says whose threshold it is", (tickDefault?.title ?? "").includes("default"), tickDefault?.title ?? "<none>");
hostMessage({ type: "compactThreshold", percent: 55 });
check("flyout switches to override state", flyout.querySelector(".threshold-title").textContent.includes("Force session auto-compact"), flyout.querySelector(".threshold-title").textContent);
const tickOverride = meter.querySelector(".context-tick");
check("tick moves to the override and marks itself as one",
	tickOverride?.style.left === "55%" && tickOverride.className.includes("override"),
	`${tickOverride?.style.left ?? "<none>"} ${tickOverride?.className ?? ""}`);
// #49: nothing inside the popover may close it — a range drag ends in a click on the slider
posted.length = 0;
tSlider.value = "40";
tSlider.dispatchEvent(new window.Event("input", { bubbles: true }));
tSlider.dispatchEvent(new window.Event("change", { bubbles: true }));
tSlider.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("slider drag posts the threshold and keeps the popover open",
	posted.some((m) => m.type === "setCompactThreshold" && m.percent === 40) && flyout.className.includes("visible"),
	`visible=${flyout.className}`);
// #41/#49: the reset is the small circle-arrow, and it restores the agent level,
// shows its percentage, and leaves the popover standing.
const resetBtn = flyout.querySelector(".threshold-reset");
check("reset is an icon control, not a wrapping word button", !!resetBtn?.querySelector("svg") && resetBtn.textContent === "", JSON.stringify(resetBtn?.textContent ?? "<none>"));
posted.length = 0;
resetBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("reset clears the session override", posted.some((m) => m.type === "setCompactThreshold" && m.percent === null), JSON.stringify(posted));
check("reset restores the agent level and shows its percentage",
	flyout.querySelector(".threshold-title").textContent.includes("Agent auto-compact") && flyout.querySelector(".threshold-value").textContent.includes("94%"),
	`${flyout.querySelector(".threshold-title").textContent} / ${flyout.querySelector(".threshold-value").textContent}`);
const tickReset = meter.querySelector(".context-tick");
check("tick returns to the agent default", tickReset?.style.left === "94%" && !tickReset.className.includes("override"),
	`${tickReset?.style.left ?? "<none>"} ${tickReset?.className ?? ""}`);
check("reset keeps the popover open", flyout.className.includes("visible"), flyout.className);
flyout.closest(".context-meter")?.classList.remove("visible");
document.body.click();

// --- install prompt banner ---
check("install banner hidden initially", !document.querySelector(".install-banner.visible"));
hostMessage({ type: "installPrompt", url: "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md", reason: "test reason" });
const banner = document.querySelector(".install-banner.visible");
check("install banner appears on prompt", !!banner, document.querySelector(".install-card")?.textContent?.slice(0, 60) ?? "");
check("banner links the quickstart", banner?.querySelector(".install-cta") !== null);
posted.length = 0;
banner.querySelector(".install-dismiss").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("dismiss posts and hides", !document.querySelector(".install-banner.visible") && posted.some((m) => m.type === "dismissInstallPrompt"));

// --- spawn cards: announced inline on new child registrations, clickable to view ---
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "sub-a", activeSessionId: "aaaa1111", name: "verify-threads", runtimeKind: "subagent", created: "2026-08-07T15:00:00Z", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
	spawned: [{ activeSessionId: "aaaa1111", name: "verify-threads", created: "2026-08-07T15:00:00Z" }],
});
const spawnCard = document.querySelector(".spawned-card");
check("spawn card visible with name", !!spawnCard && spawnCard.textContent.includes("Subagent spawned — verify-threads"), spawnCard?.textContent ?? "");
posted.length = 0;
spawnCard.querySelector(".spawned-view").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("spawn card click posts browseChild", posted.some((m) => m.type === "browseChild" && m.activeSessionId === "aaaa1111"));
// seeded baseline (second payload): ended child gets NO card at all; running one keeps theirs
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "sub-a", activeSessionId: "aaaa1111", name: "verify-threads", runtimeKind: "subagent", created: "2026-08-07T15:00:00Z", isStreaming: false, attachedClients: 0, rlmDepth: 1 },
	],
});
check("re-broadcast does not duplicate the spawn card", document.querySelectorAll(".spawned-card").length === 1);
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "high" }, status: baseStatus });
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "old-sub", activeSessionId: "bbbb2222", name: "login-session", runtimeKind: "subagent", created: "2026-08-06T10:00:00Z", isStreaming: false, attachedClients: 0, rlmDepth: 1 },
		{ id: "live-sub", activeSessionId: "cccc3333", name: "audit-live", runtimeKind: "subagent", created: "2026-08-07T16:00:00Z", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
});
const cards = document.querySelectorAll(".spawned-card");
check("baseline seeds cards only for running children", cards.length === 1 && cards[0].textContent.includes("Subagent spawned — audit-live"), cards.length + " cards: " + [...cards].map((c) => c.textContent).join("|"));
check("re-broadcast does not duplicate the spawn card", document.querySelectorAll(".spawned-card").length === 1);

// --- spawn card placement: at the creation point in the run, not dumped at the bottom.
// Message timestamps are epoch-ms numbers (the agent writes Date.now()), which is
// what tags the rows the ordered insert compares against.
const spawnT0 = Date.parse("2026-08-07T12:00:00Z");
const spawnCreated = new Date(spawnT0 + 300_000).toISOString();
hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "kick off the audit", timestamp: spawnT0 },
		{ role: "assistant", model: "kimi", stopReason: "stop", content: [{ type: "text", text: "audit finished" }], timestamp: spawnT0 + 600_000 },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "high" },
	status: baseStatus,
});
hostMessage({
	type: "sessionChildren",
	children: [
		{ id: "mid-sub", activeSessionId: "dddd4444", name: "mid-run", runtimeKind: "subagent", created: spawnCreated, status: "running", isStreaming: true, attachedClients: 0, rlmDepth: 1 },
	],
	spawned: [{ activeSessionId: "dddd4444", name: "mid-run", created: spawnCreated }],
});
const placed = [...document.querySelector(".messages").children];
const cardIdx = placed.findIndex((n) => n.className.includes("spawned-card"));
const userIdx = placed.findIndex((n) => n.className.includes("row-user"));
const asstIdx = placed.findIndex((n) => n.className.includes("row-assistant"));
check(
	"spawn card sits between the messages that bracket its start time",
	cardIdx > userIdx && cardIdx < asstIdx && userIdx >= 0 && asstIdx >= 0,
	`user=${userIdx} card=${cardIdx} assistant=${asstIdx}`,
);

// --- history: running indicator + stop/rename/delete ordering ---
hostMessage({
	type: "history",
	sessions: [
		{ id: "run-1", path: "/tmp/run.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "live worker", inWorkspace: true, running: true },
		{ id: "idle-1", path: "/tmp/idle.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "quiet archive", inWorkspace: true },
	],
});
const runRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("live worker"));
check("running row shows the animated mark", !!runRow.querySelector(".running-dot"));
const idleRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("quiet archive"));
check("idle row has no running mark", !idleRow.querySelector(".running-dot"));
const actTitles = [...runRow.querySelectorAll(".history-action")].map((b) => b.title);
check("actions ordered stop -> rename -> delete", actTitles[0].startsWith("Stop") && actTitles.some((t) => t.startsWith("Rename")) && actTitles.some((t) => t.startsWith("Delete")), actTitles.join("|"));
posted.length = 0;
[...runRow.querySelectorAll(".history-action")].find((b) => b.title.startsWith("Stop")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("stop posts stopSession", posted.some((m) => m.type === "stopSession" && m.sessionId === "run-1"));
hostMessage({
	type: "history",
	sessions: [
		{ id: "hist-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "hist-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});

// --- session title with pencil rename (header) ---
hostMessage({ type: "status", status: { ...baseStatus, sessionName: "vscode-extension" } });
const titleWrap = document.querySelector(".session-title-wrap");
check("session title shown in header", titleWrap && titleWrap.querySelector(".session-title").textContent === "vscode-extension");
check("title pencil present", !!titleWrap.querySelector(".title-edit-btn"));
posted.length = 0;
titleWrap.querySelector(".title-edit-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const titleInput = document.querySelector(".session-title-input");
check("editing swaps the span for an input", !!titleInput && titleInput.value === "vscode-extension");
titleInput.value = "shiny-browser-app";
titleInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("enter posts renameSession", posted.some((m) => m.type === "renameSession" && m.name === "shiny-browser-app"));
check("input restores to the span after commit", !!document.querySelector(".session-title-wrap .session-title"));

// --- history row pencil rename ---
posted.length = 0;
const hRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("local chat"));
const pencil = [...hRow.querySelectorAll(".history-action")].find((b) => b.title === "Rename session");
check("history row has pencil action", !!pencil);
pencil.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const renameInput = hRow.querySelector(".history-rename-input");
check("history rename input appears", !!renameInput);
renameInput.value = "local-chat-updated";
renameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("enter posts renameHistorySession", posted.some((m) => m.type === "renameHistorySession" && m.sessionId === "hist-a" && m.name === "local-chat-updated"), "payload=" + JSON.stringify(posted.filter((m) => m.type === "renameHistorySession")));

// --- model pill truncation + hover shows full name ---
hostMessage({ type: "status", status: { ...baseStatus, modelLabel: "chutes/Qwen/Qwen3-235B-A22B-Thinking-2507-TEE" } });
const pillLabel = document.querySelector(".rail-pill.model .pill-label");
check("model pill truncates tastefully mid-path", pillLabel.textContent === "chutes/…/Qwen3-235B-A22B-Thinking-2507-TEE", pillLabel.textContent);
check("model pill full name on hover", document.querySelector(".rail-pill.model").title.includes("chutes/Qwen/Qwen3-235B-A22B-Thinking-2507-TEE"));

// --- history search ranking: exact beats tokens beats fuzzy; recency breaks ties ---
hostMessage({
	type: "history",
	sessions: [
		{ id: "r1", path: "/tmp/r1.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 4000).toISOString(), modifiedMs: Date.now() - 4000, name: "ray button setup", inWorkspace: true },
		{ id: "r2", path: "/tmp/r2.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "ray tracing demo", inWorkspace: true },
		{ id: "r3", path: "/tmp/r3.jsonl", cwd: "/other", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "totally different topic", inWorkspace: false },
	],
});
document.querySelector(".history-search").value = "ray";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
const rNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("exact/tokens results keep bucket order, recency breaks ties", rNames[0] === "ray tracing demo" && rNames[1] === "ray button setup", rNames.join("|"));
check("non-matching entries filtered", rNames.length === 2);

// --- inline mentions: mirror styles typed tokens; folders accepted with trailing slash ---
hostMessage({ type: "fileSearchResults", requestId: 0, files: [] }); // no-op staleness guard
textarea.value = "";
textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
// typed token styles via mirror (mirror replaces textarea's visible text)
textarea.value = "see @media/main.css and @webview/ please";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const mms = document.querySelectorAll(".composer-mirror .mm");
check("typed mentions styled in mirror", mms.length === 2 && mms[0].textContent === "@media/main.css" && mms[1].textContent === "@webview/");
check("folder token styles with trailing slash", [...mms].some((m) => m.textContent.endsWith("/")));
// typed text stays intact for send
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const sentPrompt = posted.find((m) => m.type === "prompt");
check("send keeps inline @text intact", !!sentPrompt && sentPrompt.payload.text.includes("@media/main.css") && sentPrompt.payload.text.includes("@webview/"));

// folder via the autocomplete: dir row gets trailing slash + dir class
textarea.value = "@web";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const req2 = posted.filter((m) => m.type === "searchFiles").at(-1);
check("mention query posts searchFiles", !!req2 && req2.query === "web");
posted.length = 0;
hostMessage({
	type: "fileSearchResults",
	requestId: req2.requestId,
	files: [
		{ path: "webview", isDir: true },
		{ path: "webview/main.ts", isDir: false },
	],
});
const dirRow = [...document.querySelectorAll(".ac-item")].find((r) => r.textContent.includes("webview/"));
check("folder row shows trailing slash + dir class", !!dirRow && dirRow.classList.contains("dir") && dirRow.querySelector(".ac-label").textContent === "webview/");
posted.length = 0;
dirRow.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
check("folder accepted with trailing slash", textarea.value.includes("@webview/"));
check("mirror styles folder token", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@webview/"));
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const prompt2 = posted.find((m) => m.type === "prompt");
check("folder mention sent inline", !!prompt2 && prompt2.payload.text.includes("@webview/"));

// --- mentions the pattern alone cannot recognise (#19: it must LOOK selected) ---
posted.length = 0;
textarea.value = "@LICE";
textarea.selectionStart = textarea.selectionEnd = 5;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const reqLic = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: reqLic.requestId, files: [{ path: "LICENSE", isDir: false }] });
[...document.querySelectorAll(".ac-item")][0].dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
check("extensionless mention pilled once accepted", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@LICENSE"), textarea.value);
textarea.value = "look at @.github/workflows/publish.yml now";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("dot-prefixed path styles", [...document.querySelectorAll(".composer-mirror .mm")].some((m) => m.textContent === "@.github/workflows/publish.yml"));
textarea.value = "ping @bob about it";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
check("bare @word is never a mention", document.querySelectorAll(".composer-mirror .mm").length === 0);

// --- a mention search with no matches must disarm the panel, not swallow Enter ---
posted.length = 0;
textarea.value = "explain @zzzmissing";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
const reqMiss = posted.filter((m) => m.type === "searchFiles").at(-1);
hostMessage({ type: "fileSearchResults", requestId: reqMiss.requestId, files: [] });
posted.length = 0;
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("zero-result mention does not swallow Enter", posted.some((m) => m.type === "prompt"), JSON.stringify(posted.map((m) => m.type)));

// --- `+` -> "Mention a file in chat" mid-sentence: needs a separator or nothing opens ---
textarea.value = "review the changes in";
textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
posted.length = 0;
const plusBtn = [...document.querySelectorAll(".composer-rail .icon-btn")].find((b) => b.title.startsWith("Attach"));
plusBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
[...document.querySelectorAll(".dropdown-item")].find((r) => r.textContent.includes("Mention a file")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("+ mention inserts a separated @", textarea.value === "review the changes in @", JSON.stringify(textarea.value));
check("+ mention opens the file search", posted.some((m) => m.type === "searchFiles"), JSON.stringify(posted.map((m) => m.type)));
textarea.value = "";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));

// --- sticky drafts are per thread: an empty payload CLEARS, it is not "no news" ---
hostMessage({ type: "draft", text: "remember to check the retry path" });
check("draft restored into the composer", textarea.value === "remember to check the retry path", textarea.value);
hostMessage({ type: "draft", text: "" });
check("empty draft clears the box so it can't follow into the next thread", textarea.value === "", textarea.value);

// --- paste image on a text-only model shows a composer hint ---
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
posted.length = 0;
const pasteEvent = new window.Event("paste", { bubbles: true, cancelable: true });
// happy-dom has no DataTransfer-backed ClipboardEvent; inject the shape onPaste reads.
pasteEvent.clipboardData = { files: [{ type: "image/png", name: "shot.png" }] };
textarea.dispatchEvent(pasteEvent);
const pasteHint = document.querySelector(".composer-hint");
check(
	"paste image on text-only model shows hint",
	!!pasteHint && pasteHint.classList.contains("visible") && pasteHint.textContent.includes("text-only"),
	pasteHint?.textContent ?? "<no hint>",
);
check("paste did not post a prompt", !posted.some((m) => m.type === "prompt"));

// --- imagePicked on a text-only model is refused with a hint; on vision it attaches ---
posted.length = 0;
hostMessage({ type: "imagePicked", images: [{ data: "aGk=", mimeType: "image/png", name: "pic.png" }] });
check("image pick refused on text-only model", document.querySelectorAll(".composer-chips .compose-chip.image").length === 0);
check("refusal hint visible", pasteHint.classList.contains("visible") && pasteHint.textContent.includes("text-only"), pasteHint.textContent);
// switch back to a vision model: the chip now attaches
hostMessage({ type: "status", status: { ...baseStatus } });
hostMessage({ type: "imagePicked", images: [{ data: "aGk=", mimeType: "image/png", name: "pic.png" }] });
check("image chip rendered on vision model", document.querySelectorAll(".composer-chips .compose-chip.image").length === 1);
// then switching to a text-only model strips + warns on send
hostMessage({ type: "status", status: { ...baseStatus, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
posted.length = 0;
textarea.value = "with image";
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const guardedPrompt = posted.find((m) => m.type === "prompt");
check("send still posts prompt text", !!guardedPrompt && guardedPrompt.payload.text === "with image");
check("images stripped on text-only send", !!guardedPrompt && guardedPrompt.payload.images.length === 0);
check("send guard hint visible", pasteHint.classList.contains("visible") && pasteHint.textContent.includes("Dropped images"),
	pasteHint.textContent);
check("chips cleared after guarded send", document.querySelectorAll(".composer-chips .compose-chip").length === 0);
check("optimistic bubble has no image strip", !document.querySelector(".bubble-images"));
hostMessage({ type: "status", status: { ...baseStatus } });

// --- @-mention chips in user bubbles ---
hostMessage({
	type: "snapshot",
	messages: [
		{ role: "user", content: "edit @src/a.ts now" },
		{ role: "user", content: "mail name@domain.com or see https://x.io/@u/p end" },
	],
	state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" },
	status: baseStatus,
});
const chips = [...document.querySelectorAll(".mention-chip")];
check("mention chip rendered for @path", chips.length === 1 && chips[0].textContent === "@src/a.ts", `${chips.length} chips`);
check("email and URL do not become chips", document.querySelector(".messages").textContent.includes("name@domain.com"));
posted.length = 0;
chips[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const openFileMsg = posted.find((m) => m.type === "openFile");
check("chip click posts openFile", !!openFileMsg && openFileMsg.path === "src/a.ts", JSON.stringify(openFileMsg));

// --- history delete: inline confirm posts deleteSession ---
const historyBtnAgain = [...document.querySelectorAll(".icon-btn")].find((b) => b.title === "Sessions in this workspace");
historyBtnAgain.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
// Search must be cleared BEFORE the fixture: the needle blocks lastSessions updates.
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
hostMessage({
	type: "history",
	sessions: [
		{ id: "sess-a", path: "/tmp/a.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "local chat", inWorkspace: true },
		{ id: "sess-b", path: "/tmp/b.jsonl", cwd: "/other/proj", timestamp: new Date().toISOString(), firstPrompt: "work on proj", inWorkspace: false },
	],
});
const delItem = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("local chat"));
posted.length = 0;
[...delItem.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Delete")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("delete arms inline confirm", delItem.classList.contains("confirming"));
const confirmBtn = delItem.querySelector(".history-action.destructive");
check("confirm button labeled Delete", !!confirmBtn && confirmBtn.textContent.includes("Delete"));
confirmBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const delMsg = posted.find((m) => m.type === "deleteSession");
check(
	"confirm posts deleteSession",
	!!delMsg && delMsg.path === "/tmp/a.jsonl" && delMsg.sessionId === "sess-a",
	JSON.stringify(delMsg),
);
check("confirm disarms item", !delItem.classList.contains("confirming"));
check("no resume fired during delete", !posted.some((m) => m.type === "switchSession"));

// --- history delete: cancel restores the item without posting ---
const cancelItem = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("work on proj"));
posted.length = 0;
[...cancelItem.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Delete")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("second item arms confirm", cancelItem.classList.contains("confirming"));
const cancelBtn = [...cancelItem.querySelectorAll(".history-action")].find((b) => b.title === "Cancel");
cancelBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("cancel posts no deleteSession", !posted.some((m) => m.type === "deleteSession"));
const restored = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("work on proj"));
check(
	"cancel restores item",
	!!restored && restored !== cancelItem && !restored.classList.contains("confirming") && !!restored.querySelector(".history-action"),
);

// --- history: archive is a distinct, non-destructive action (CLI stop/deactivate) ---
hostMessage({
	type: "history",
	sessions: [
		{ id: "arch-1", path: "/tmp/arch.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), name: "finished experiment", inWorkspace: true },
	],
});
const archRow = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes("finished experiment"));
const archBtn = [...archRow.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Archive"));
check("history row offers archive alongside delete", !!archBtn);
posted.length = 0;
archBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("archive arms its own confirm", archRow.classList.contains("confirming"));
const archConfirm = [...archRow.querySelectorAll(".history-action")].find((b) => b.textContent.includes("Archive"));
check("archive confirm is not styled destructive", !archConfirm.classList.contains("destructive"));
archConfirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("confirm posts archiveSession", posted.some((m) => m.type === "archiveSession" && m.sessionId === "arch-1"), JSON.stringify(posted));
check("archive does not post deleteSession", !posted.some((m) => m.type === "deleteSession"));

// --- history search reaches the host, and transcript hits rank and explain themselves ---
posted.length = 0;
document.querySelector(".history-search").value = "octopus";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 400));
check("typing asks the host to search the conversations", posted.some((m) => m.type === "searchHistory" && m.query === "octopus"), JSON.stringify(posted));
hostMessage({
	type: "history",
	sessions: [
		{ id: "s-name", path: "/tmp/s-name.jsonl", cwd: "/ws", timestamp: new Date(Date.now() - 90_000).toISOString(), modifiedMs: Date.now() - 90_000, name: "octopus notes", inWorkspace: true },
		{ id: "s-body", path: "/tmp/s-body.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "unrelated title", inWorkspace: true, matchSnippet: "…we talked about the octopus problem…" },
		{ id: "s-body", path: "/tmp/s-body.jsonl", cwd: "/ws", timestamp: new Date().toISOString(), modifiedMs: Date.now(), name: "unrelated title", inWorkspace: true, matchSnippet: "…we talked about the octopus problem…" },
	],
});
const searchNames = [...document.querySelectorAll(".history-item .history-item-name")].map((n) => n.textContent);
check("transcript-only hit survives the local filter", searchNames.includes("unrelated title"), searchNames.join("|"));
check("duplicate rows from the host are collapsed by path", searchNames.length === 2, searchNames.join("|"));
check("match snippet shown as the row subtitle", !!document.querySelector(".history-item-sub.match"));
document.querySelector(".history-search").value = "";
document.querySelector(".history-search").dispatchEvent(new window.Event("input", { bubbles: true }));

// --- thread diffs: the Changes panel only ever asserts what it can show ---
const tdPanel = document.querySelector(".td-panel");
check("changes panel exists but stays hidden with no changes", !!tdPanel && !tdPanel.classList.contains("visible"));
hostMessage({
	type: "threadDiffs",
	files: [
		{ path: "src/a.ts", viaSource: "edit", hunks: [{ removed: ["old"], added: ["new"] }, { removed: [], added: ["x"], agent: "verify-vault" }] },
		{ path: "src/b.ts", viaSource: "edit", hunks: [{ removed: [], added: ["only"], agent: "verify-vault" }] },
		// A row with no hunks would claim a change with nothing behind it.
		{ path: "src/ghost.ts", viaSource: "edit", hunks: [] },
	],
});
check("panel appears once there are changes", tdPanel.classList.contains("visible"));
check("hunkless row is dropped", document.querySelector(".td-header").textContent.includes("Changes (2)"), document.querySelector(".td-header").textContent);
document.querySelector(".td-header").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tdPaths = [...document.querySelectorAll(".td-path")].map((n) => n.textContent);
check("expanded list shows the changed files", tdPaths.join("|") === "src/a.ts|src/b.ts", tdPaths.join("|"));
check("subagent named on the row it edited", [...document.querySelectorAll(".td-file")][1].textContent.includes("verify-vault"));
check("coverage footnote states what the panel cannot show", (document.querySelector(".td-foot")?.textContent ?? "").includes("changed-files strip"));
[...document.querySelectorAll(".td-row")][0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tdDetail = document.querySelector(".td-detail");
check("hunk lines render red/green", tdDetail.querySelectorAll(".diff-line.del").length === 1 && tdDetail.querySelectorAll(".diff-line.add").length === 2);
const byLabels = [...tdDetail.querySelectorAll(".td-by")].map((n) => n.textContent);
check("a file two agents touched attributes every block", byLabels.join("|") === "this session|subagent verify-vault", byLabels.join("|"));

// --- C12: the two links the operator asked for, and the butterfly on the entry ---
posted.length = 0;
const kebabBtn = [...document.querySelectorAll(".topbar .icon-btn")].find((b) => b.title === "Session actions");
kebabBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const kebabMenu = document.querySelector(".menu.visible");
check("kebab menu opens", !!kebabMenu);
const kebabItems = [...kebabMenu.querySelectorAll(".menu-item")];
const visitItem = kebabItems[kebabItems.length - 1];
check("bottom kebab entry is Visit Prime Intellect", visitItem.textContent.trim() === "Visit Prime Intellect", kebabItems.map((i) => i.textContent.trim()).join("|"));
// #44: the butterfly, not a generic link glyph — same mark as the brand.
check("that entry wears the butterfly", !!visitItem.querySelector('svg[viewBox="0 0 178 178"]'));
check("every kebab entry says what it does", kebabItems.every((i) => i.textContent.trim().length > 0));
visitItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("visit opens the Prime Intellect dashboard", posted.some((m) => m.type === "openExternal" && m.url === "https://app.primeintellect.ai"), JSON.stringify(posted));
check("choosing an entry closes the menu", !document.querySelector(".menu.visible"));
posted.length = 0;
document.querySelector(".topbar .brand").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("header mark opens the prime-agent write-up",
	posted.some((m) => m.type === "openExternal" && m.url === "https://www.primeintellect.ai/blog/prime-agent#article-top"), JSON.stringify(posted));

// --- #5/C10: steer vs queue while a run is live, and a Stop that really aborts ---
const behaviorPill = document.querySelector(".composer-rail .rail-pill.behavior");
const stopBtn = document.querySelector(".composer-dock .send-btn.stop");
check("run controls stay hidden while idle", behaviorPill.style.display === "none" && stopBtn.style.display === "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
hostMessage({ type: "status", status: { ...baseStatus, streaming: true } });
check("run controls appear while streaming", behaviorPill.style.display !== "none" && stopBtn.style.display !== "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
check("delivery starts at the configured default", behaviorPill.textContent === "steer", behaviorPill.textContent);
behaviorPill.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("toggle flips to queue and explains the difference",
	behaviorPill.textContent === "queue" && behaviorPill.title.includes("when the run ends"), `${behaviorPill.textContent} — ${behaviorPill.title}`);
// The choice is only real if it rides along with the message.
posted.length = 0;
textarea.value = "and then run the tests";
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
const midRunPrompt = posted.find((m) => m.type === "prompt");
check("a mid-run send carries the chosen delivery to the host", midRunPrompt?.payload?.streamingBehavior === "followUp",
	JSON.stringify(midRunPrompt?.payload?.streamingBehavior ?? "<none>"));
posted.length = 0;
stopBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("stop posts abort", posted.some((m) => m.type === "abort"), JSON.stringify(posted));
// #68: while observing, the run on screen belongs to another client — our Stop
// would not reach it, so it must not be offered.
hostMessage({ type: "status", status: { ...baseStatus, streaming: true, observingId: "other-1" } });
check("stop is withdrawn while watching someone else's run", stopBtn.style.display === "none", stopBtn.style.display);
hostMessage({ type: "status", status: { ...baseStatus, streaming: false } });
check("run controls retire when the run ends", behaviorPill.style.display === "none" && stopBtn.style.display === "none",
	`behavior=${behaviorPill.style.display} stop=${stopBtn.style.display}`);
check("delivery falls back to the configured default between runs", behaviorPill.textContent === "steer", behaviorPill.textContent);

// --- #45/#19/#53: the scroll lock and the jump-to-bottom pill ---
// happy-dom does no layout, so every metric is 0 and the handler would always
// conclude "already at the bottom". Stub the geometry to get a real scrollback.
Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
scroller.scrollTop = 0;
scroller.dispatchEvent(new window.Event("scroll"));
const jumpBtn = scroller.querySelector(".jump-to-latest");
check("jump-to-bottom appears once the reader scrolls away", !!jumpBtn && jumpBtn.className.includes("visible"), jumpBtn?.className ?? "<none>");
check("jump button is a labeled down arrow", jumpBtn?.title === "Jump to bottom" && jumpBtn.getAttribute("aria-label") === "Jump to bottom" && jumpBtn.className.includes("down"),
	`${jumpBtn?.title ?? "<none>"} / ${jumpBtn?.className ?? ""}`);
hostMessage({ type: "event", event: { type: "message_start", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going" }] } } });
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going and going" }] } } });
check("streaming never yanks a scrolled-up reader back down", scroller.scrollTop === 0, String(scroller.scrollTop));
jumpBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("jump returns to the latest and retires the pill", scroller.scrollTop === 2000 && !jumpBtn.className.includes("visible"),
	`${scroller.scrollTop} / ${jumpBtn.className}`);
hostMessage({ type: "event", event: { type: "message_update", message: { role: "assistant", model: "kimi", content: [{ type: "text", text: "still going and going and going" }] } } });
check("auto-follow resumes after the jump", scroller.scrollTop === 2000, String(scroller.scrollTop));

console.log(failed === 0 ? "\nPASS webview harness" : `\n${failed} webview checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
