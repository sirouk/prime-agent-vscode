/**
 * Rows the Rust agent (0.10+) produces that the TypeScript agent never did,
 * rendered through the real built webview in happy-dom:
 *
 *  - the code tool is named `python_repl` (the TypeScript build called it
 *    `ipython`), and keying on one spelling left the other's cards as opaque
 *    tools — no glyph, no section label, a JSON copy fence;
 *  - custom messages can carry an ARRAY of content blocks, which used to throw
 *    from `content.trim()` and stop the whole snapshot rendering midway;
 *  - `branchSummary` was dropped and `bashExecution` showed only `! cmd`;
 *  - model-facing bookkeeping (heartbeat prompts, agent-message headers) is long
 *    and repeated every turn, and should fold.
 */

import { Window } from "happy-dom";
import * as fs from "node:fs";

const window = new Window({ url: "https://webview.local/" });
const document = window.document;
document.body.innerHTML = '<div id="app"></div>';
document.body.className = "vscode-dark";
const posted = [];
const vscodeApi = { postMessage: (m) => posted.push(m), getState: () => undefined, setState: () => {} };
Object.assign(globalThis, {
	window,
	document,
	HTMLElement: window.HTMLElement,
	HTMLAnchorElement: window.HTMLAnchorElement,
	SVGSVGElement: window.SVGSVGElement,
	HTMLInputElement: window.HTMLInputElement,
	FileReader: window.FileReader,
	Event: window.Event,
	acquireVsCodeApi: () => vscodeApi,
});
window.acquireVsCodeApi = () => vscodeApi;

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const hostMessage = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }));

window.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));

const status = {
	connected: true, streaming: false, compacting: false, retrying: false, restoring: false,
	modelLabel: "max/gpt", thinkingLevel: "high", sessionName: "rust", sessionId: "s1",
	statsText: "", modelProvider: "max", modelId: "gpt",
};

const LONG_HEARTBEAT = `Heartbeat tick 7. ${"Review the open items and continue the goal. ".repeat(12)}`;
let threw = null;
try {
	hostMessage({
		type: "snapshot",
		messages: [
			{ role: "user", content: "go" },
			{
				role: "assistant", model: "gpt", stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "p1", name: "python_repl", arguments: { code: "import os\nprint(os.getcwd())" } },
					{ type: "toolCall", id: "p2", name: "python_repl", arguments: { code: "%%bash\ncd /repo\nnpm test" } },
				],
			},
			{ role: "toolResult", toolCallId: "p1", toolName: "python_repl", content: [{ type: "text", text: "/repo" }] },
			{ role: "toolResult", toolCallId: "p2", toolName: "python_repl", content: [{ type: "text", text: "ok" }] },
			// content as BLOCKS — a /goal with images makes goal_context exactly this.
			{ role: "custom", customType: "goal_context", display: true, content: [{ type: "text", text: "Goal: ship the release." }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 1 },
			{ role: "custom", customType: "heartbeat_prompt", display: true, content: LONG_HEARTBEAT, timestamp: 2 },
			{
				role: "custom", customType: "agent_message", display: true, timestamp: 3,
				content: "[agent message from parent]\nProtocol header line\nAnother header line\nMore header\nEven more header\nThe real body was in details.",
				details: { message: "Please summarize the failing tests." },
			},
			{ role: "custom", customType: "bookkeeping", display: false, content: "HIDDEN", timestamp: 4 },
			{ role: "branchSummary", summary: "Tried the regex approach and abandoned it.", fromId: "e1", timestamp: 5 },
			{ role: "bashExecution", command: "git status", output: "On branch main\nnothing to commit", exitCode: 0, cancelled: false, truncated: false, timestamp: 6 },
			{ role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: true, excludeFromContext: true, timestamp: 7 },
			{ role: "assistant", model: "gpt", stopReason: "stop", content: [{ type: "text", text: "Done." }] },
		],
		state: { model: { provider: "max", id: "gpt" }, thinkingLevel: "high" },
		status,
		steerDefault: "steer",
	});
} catch (error) {
	threw = error;
}
check("a snapshot with every Rust-only row renders without throwing", threw === null, threw ? String(threw.stack ?? threw).slice(0, 200) : "");

const scroller = document.querySelector(".messages");
const cards = [...scroller.querySelectorAll(".tool")];
check("python_repl cards are recognised as python/shell cards", cards.length === 2 && cards.every((c) => ["python", "shell"].includes(c.dataset.toolKind)), cards.map((c) => `${c.dataset.toolName}/${c.dataset.toolKind}`).join("|"));
const shell = cards.find((c) => c.dataset.toolKind === "shell");
check("a %%bash python_repl cell is a shell card with the magic stripped", !!shell && !(shell.querySelector(".tool-section:not(.tool-result) pre")?.textContent ?? "").includes("%%bash"));
check("the collapsed row carries a glyph, not the tool's name", cards.every((c) => !!c.querySelector(".tool-glyph") && !c.querySelector(".tool-name")));
check("hovering the glyph still names the real tool", cards.every((c) => c.querySelector(".tool-glyph")?.title === "python_repl"));

const notes = [...scroller.querySelectorAll(".custom-note")];
const goal = notes.find((n) => n.textContent.includes("Goal: ship the release."));
check("array-valued custom content renders its text", !!goal, notes.map((n) => n.textContent.slice(0, 30)).join("|"));
check("a short note stays a plain note", !!goal && goal.tagName === "DIV");
const heartbeat = notes.find((n) => n.textContent.includes("Heartbeat tick 7"));
check("a long heartbeat prompt folds behind its first line", !!heartbeat && heartbeat.tagName === "DETAILS" && !heartbeat.open && !!heartbeat.querySelector("summary .custom-note-first"));
const agentMsg = notes.find((n) => n.textContent.includes("Please summarize the failing tests."));
check("an agent message shows its body, not its protocol header", !!agentMsg && !agentMsg.textContent.includes("Protocol header line"));
check("a display:false note stays hidden", !notes.some((n) => n.textContent.includes("HIDDEN")));

const summaries = [...scroller.querySelectorAll("details.compaction-summary")];
const branch = summaries.find((d) => d.querySelector("summary")?.textContent === "Branch summary");
check("a branch summary is rendered with its text", !!branch && branch.textContent.includes("abandoned it"));
const ran = summaries.find((d) => (d.querySelector("summary")?.textContent ?? "").startsWith("! git status"));
check("a !command shows its status and output", !!ran && ran.querySelector("summary").textContent.endsWith("ok") && ran.textContent.includes("nothing to commit"), ran?.querySelector("summary")?.textContent ?? "<none>");
const failedRun = summaries.find((d) => (d.querySelector("summary")?.textContent ?? "").startsWith("! false"));
check("a failed !command says so and notes truncation", !!failedRun && failedRun.querySelector("summary").textContent.endsWith("exit 1") && failedRun.textContent.includes("output truncated"));
check("a !! command says it was withheld from the model", failedRun?.querySelector("summary")?.title.includes("Not sent to the model") === true);
check("the final assistant row still rendered after all of them", scroller.textContent.includes("Done."));

// ---- a quota park is a pause, not a failure ------------------------------------------------
hostMessage({ type: "event", event: { type: "agent_start" } });
hostMessage({ type: "event", event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "429 usage limit" } });
hostMessage({
	type: "event",
	event: { type: "auto_retry_end", success: false, attempt: 1, finalError: "Session is parked until 2026-10-22T12:00:00.000Z waiting for the provider usage reset; this turn ended without a retry: quota" },
});
const parkRow = [...scroller.querySelectorAll(".retry-row")].at(-1);
check("a parked session reads as a pause that resumes by itself", !!parkRow && parkRow.textContent.includes("Paused until") && parkRow.textContent.includes("resumes by itself"), parkRow?.textContent ?? "<none>");
check("and is not painted as fatal", !!parkRow && !parkRow.classList.contains("fatal"));
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
hostMessage({ type: "event", event: { type: "agent_start" } });
hostMessage({ type: "event", event: { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 1000, errorMessage: "503" } });
hostMessage({ type: "event", event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "503 upstream unavailable" } });
const failRow = [...scroller.querySelectorAll(".retry-row")].at(-1);
check("a real give-up is still fatal", !!failRow && failRow.classList.contains("fatal") && failRow.textContent.includes("giving up"), failRow?.textContent ?? "<none>");

// ---- a turn that fails before the model is called says why -------------------------------
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
hostMessage({ type: "event", event: { type: "agent_start" } });
hostMessage({ type: "event", event: { type: "turn_start" } });
hostMessage({ type: "event", event: { type: "turn_end", error: "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key." } });
hostMessage({ type: "event", event: { type: "agent_end", messages: [] } });
const errorNote = [...scroller.querySelectorAll(".system-note.error")].at(-1);
check("a pre-model failure is shown, with the agent's own instructions", !!errorNote && errorNote.textContent.includes("No API key found for openai") && errorNote.textContent.includes("/login"), errorNote?.textContent ?? "<none>");

// ---- the changed-files strip only says "other" when it could subtract the agent's own edits ----
const stripLabel = () => document.querySelector(".changed-files .cf-label")?.textContent ?? "";
hostMessage({ type: "changedFiles", files: ["a.txt", "b.txt"] });
check("with attribution the strip reports other files", stripLabel() === "2 other files changed", stripLabel());
hostMessage({ type: "changedFiles", files: ["a.txt", "b.txt"], attributed: false });
check("without it the strip does not claim they are another party's", stripLabel() === "2 files changed", stripLabel());
check("and its tooltip says the agent's own work is included", /own work/.test(document.querySelector(".changed-files .cf-header")?.title ?? ""));
hostMessage({ type: "changedFiles", files: ["only.txt"], attributed: false });
check("singular reads naturally", stripLabel() === "1 file changed", stripLabel());

// ---- a goal in play is named in the header ----------------------------------------------------
const liveText = () => document.querySelector(".live-label")?.textContent ?? "";
hostMessage({ type: "status", status: { ...status, goal: { active: true, status: "active", objective: "ship the release" } } });
check("an active goal is named beside the state", /live · goal active/.test(liveText()), liveText());
check("and its objective is on hover", (document.querySelector(".live-label")?.title ?? "").includes("Goal: ship the release"));
hostMessage({ type: "status", status: { ...status, goal: { active: false, status: "paused", objective: "ship the release" } } });
check("a paused goal says so", /goal paused/.test(liveText()), liveText());
hostMessage({ type: "status", status: { ...status, goal: { active: false, status: "complete", objective: "ship the release" } } });
check("a finished goal leaves no residue", !/goal/.test(liveText()), liveText());
hostMessage({ type: "status", status: { ...status, goal: null } });
check("no goal, no word", !/goal/.test(liveText()), liveText());

// ---- an empty chat keeps its welcome screen across snapshots --------------------------------
// (a second empty snapshot used to leave the panel blank for good). A fresh page, since the
// transcript above has content.
{
	const w2 = new Window({ url: "https://webview.local/" });
	const d2 = w2.document;
	d2.body.innerHTML = '<div id="app"></div>';
	Object.assign(globalThis, { window: w2, document: d2, HTMLElement: w2.HTMLElement, HTMLAnchorElement: w2.HTMLAnchorElement, SVGSVGElement: w2.SVGSVGElement, HTMLInputElement: w2.HTMLInputElement, FileReader: w2.FileReader, Event: w2.Event, acquireVsCodeApi: () => vscodeApi });
	w2.acquireVsCodeApi = () => vscodeApi;
	w2.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));
	const empty = { type: "snapshot", messages: [], state: null, status, steerDefault: "steer" };
	const post2 = (data) => w2.dispatchEvent(new w2.MessageEvent("message", { data }));
	post2(empty);
	check("the first empty snapshot shows the welcome screen", !!d2.querySelector(".welcome"));
	post2(empty);
	post2({ ...empty, durableMessages: true });
	check("and later empty snapshots do not lose it", !!d2.querySelector(".welcome"));
}

// ---- the processes panel ticks its clocks in place -------------------------------------------
// A full rebuild every second dropped keyboard focus and could eat a click.
{
	const w3 = new Window({ url: "https://webview.local/" });
	const d3 = w3.document;
	d3.body.innerHTML = '<div id="app"></div>';
	Object.assign(globalThis, { window: w3, document: d3, HTMLElement: w3.HTMLElement, HTMLAnchorElement: w3.HTMLAnchorElement, SVGSVGElement: w3.SVGSVGElement, HTMLInputElement: w3.HTMLInputElement, FileReader: w3.FileReader, Event: w3.Event, acquireVsCodeApi: () => vscodeApi });
	w3.acquireVsCodeApi = () => vscodeApi;
	w3.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));
	const post3 = (data) => w3.dispatchEvent(new w3.MessageEvent("message", { data }));
	post3({ type: "snapshot", messages: [], state: null, status, steerDefault: "steer" });
	post3({
		type: "processes",
		processes: [{ ref: "r1", source: "observed", command: "sleep 300", fullCommand: "sleep 300", state: "running", startedMs: Date.now() - 61_000, hasOutput: false }],
	});
	const rowBefore = d3.querySelector(".pr-row");
	const clockBefore = d3.querySelector(".pr-time")?.textContent;
	await new Promise((resolve) => setTimeout(resolve, 2_300));
	const rowAfter = d3.querySelector(".pr-row");
	const clockAfter = d3.querySelector(".pr-time")?.textContent;
	check("the clock advances while the process runs", !!clockBefore && !!clockAfter && clockBefore !== clockAfter, `${clockBefore} -> ${clockAfter}`);
	check("and the row itself is the same node, so focus and clicks survive", !!rowBefore && rowBefore === rowAfter);
}

// ---- one record the renderer cannot read does not take the rest of the thread with it ---------------
{
	const w4 = new Window({ url: "https://webview.local/" });
	const d4 = w4.document;
	d4.body.innerHTML = '<div id="app"></div>';
	Object.assign(globalThis, { window: w4, document: d4, HTMLElement: w4.HTMLElement, HTMLAnchorElement: w4.HTMLAnchorElement, SVGSVGElement: w4.SVGSVGElement, HTMLInputElement: w4.HTMLInputElement, FileReader: w4.FileReader, Event: w4.Event, acquireVsCodeApi: () => vscodeApi });
	w4.acquireVsCodeApi = () => vscodeApi;
	w4.eval(fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8"));
	w4.dispatchEvent(new w4.MessageEvent("message", { data: { type: "snapshot", messages: [], state: null, status, steerDefault: "steer" } }));
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
	w4.console.error = console.error;
	let broke = null;
	try {
		w4.dispatchEvent(new w4.MessageEvent("message", {
			data: {
				type: "snapshot",
				messages: [
					{ role: "user", content: "before", timestamp: 1 },
					{ role: "bashExecution", command: 5, output: 5, exitCode: 0, timestamp: 2 },
					{ role: "assistant", model: "gpt", stopReason: "stop", content: [{ type: "text", text: "after the bad one" }] },
				],
				state: { model: { provider: "max", id: "gpt" }, thinkingLevel: "high" },
				status,
				steerDefault: "steer",
			},
		}));
	} catch (error) {
		broke = error;
	} finally {
		console.error = original;
	}
	const text = d4.querySelector(".messages")?.textContent ?? "";
	check("a malformed record does not throw out of the snapshot", broke === null, broke ? String(broke.stack ?? broke).slice(0, 200) : "");
	check("it is replaced by a visible placeholder, and what follows still renders", text.includes("unreadable message") && text.includes("after the bad one") && text.includes("before"), JSON.stringify(text.slice(0, 300)));
	check("and the failure is logged, not hidden", errors.some((line) => line.includes("could not render")), JSON.stringify(errors).slice(0, 600));
}

console.log(failed === 0 ? "\nPASS webview-rust-rows" : `\n${failed} webview-rust-rows checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
