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
// reasoning model: brain pill opens the levels menu ("max" normalized & marked current)
hostMessage({ type: "status", status: { ...baseStatus } });
hostMessage({ type: "snapshot", messages: [], state: { model: { provider: "chutes", id: "kimi" }, thinkingLevel: "max" }, status: baseStatus });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const tDrop = document.querySelector(".dropdown");
check("thinking menu opens from brain pill", !!tDrop && (tDrop.querySelector(".dropdown-header")?.textContent ?? "").startsWith("Thinking —"));
const tLevels = [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("all six levels listed", tLevels.some((l) => l.startsWith("xhigh")) && tLevels.some((l) => l.startsWith("off")));
check("current level marked (max normalized)", [...(tDrop?.querySelectorAll(".dropdown-item") ?? [])].some((r) => r.className.includes("current") && r.textContent.startsWith("xhigh")));
posted.length = 0;
[...tDrop.querySelectorAll(".dropdown-item")].find((r) => r.textContent.startsWith("high")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("select posts setThinkingLevel", posted.some((m) => m.type === "setThinkingLevel" && m.level === "high"));
// available-levels feed filters the list
hostMessage({ type: "status", status: { ...baseStatus, availableThinkingLevels: ["off", "medium", "high"] } });
document.querySelector(".composer-rail .rail-pill.brain").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const treatedLevels = [...(document.querySelector(".dropdown")?.querySelectorAll(".dropdown-item") ?? [])].map((r) => r.textContent.trim());
check("available levels filter the picker", treatedLevels.length === 3 && treatedLevels.every((l) => ["off", "medium", "high"].some((a) => l.startsWith(a))), JSON.stringify(treatedLevels));
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
check("history groups rendered", document.querySelectorAll(".history-item").length === 2);
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
// host confirms the browse with a parent context: back-row appears and is clickable
hostMessage({
	type: "sessionChildren",
	children: [],
	parent: { id: "019fd749-root", activeSessionId: "019fd749main", name: "parent-agent" },
	siblings: [
		{ id: "019fdaa2-0001", activeSessionId: "abcdef123451", name: "audit-style", runtimeKind: "subagent", rlmDepth: 1, isStreaming: false, attachedClients: 1 },
	],
	viewedActiveSessionId: "abcdef123450",
});
const backRow = document.querySelector(".subagents-strip .subagents-back-row");
check("back-row appears while viewing a child", !!backRow, document.querySelector(".subagents-strip")?.textContent?.slice(0, 60) ?? "");
check("siblings section lists the other children", [...document.querySelectorAll(".subagents-list.siblings .subagent-row")].length === 1);
posted.length = 0;
backRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("back-row click posts backToParent", posted.some((m) => m.type === "backToParent"));

// --- boot splash: present on cold start, gone after first live status ---
check("boot splash visible on cold start", !!document.querySelector(".boot-splash"));
hostMessage({ type: "status", status: { ...baseStatus, connected: true, modelProvider: "chutes", modelId: "glm", modelLabel: "chutes/glm" } });
check("boot splash dismissed once connected", [...document.querySelectorAll(".boot-splash")].length === 0 || [...document.querySelectorAll(".boot-splash")].every((s) => s.className.includes("gone")));

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
check("flyout shows default state", flyout.querySelector(".threshold-title").textContent.includes("Agent auto-compact"), flyout.querySelector(".threshold-title").textContent);
hostMessage({ type: "compactThreshold", percent: 55 });
check("flyout switches to override state", flyout.querySelector(".threshold-title").textContent.includes("Force session auto-compact"), flyout.querySelector(".threshold-title").textContent);
flyout.closest(".context-meter")?.classList.remove("visible");
document.body.click();

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

console.log(failed === 0 ? "\nPASS webview harness" : `\n${failed} webview checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
