/**
 * Host-side thread-diff test: drives SessionController's Changes-panel state
 * with the payloads prime-agent really emits, without starting an agent.
 *
 * The shapes below are verbatim from the CLI: prime-agent registers exactly one
 * tool (`ipython`), and its bundled `edit` skill publishes
 * {path, oldStr, newStr, startLine} on `result.details.diffs`. Anything keyed on
 * a tool NAMED "edit"/"write"/"bash" can never fire — that is what this guards.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
require("./test/vscode-stub.cjs");

const { SessionController } = require("./dist/controller.cjs");
const { vscodeStub } = require("./test/vscode-stub.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-thread-diffs-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "td", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const posted = [];
const _mem = new Map();
const _state = { get: (k, d) => (_mem.has(k) ? _mem.get(k) : d), update: (k, v) => { _mem.set(k, v); return Promise.resolve(); } };
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: _state, workspaceState: _state },
	{ append: () => {}, appendLine: () => {} },
);
controller.attach({ post: (message) => posted.push(message) });

const lastDiffs = () => [...posted].reverse().find((m) => m.type === "threadDiffs")?.files ?? null;
const ipythonEnd = (id, diffs, isError = false) => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "ipython",
	result: { content: [{ type: "text", text: "'Edited'" }], details: { status: "ok", diffs } },
	isError,
});

// --- an ipython cell that edited a file populates the panel ---
controller.threadDiffs.track(ipythonEnd("ipython:1", [
	{ path: path.join(workdir, "src/app.ts"), oldStr: "const a = 1;", newStr: "const a = 2;\nconst b = 3;", startLine: 10 },
]));
controller.threadDiffs.post();
let files = lastDiffs();
check("edit-skill diffs reach the panel", files?.length === 1, JSON.stringify(files));
check("path shown workspace-relative", files?.[0]?.path === "src/app.ts", files?.[0]?.path);
check("hunk carries both sides", files?.[0]?.hunks?.[0]?.removed.length === 1 && files?.[0]?.hunks?.[0]?.added.length === 2);
check("source reported as edit", files?.[0]?.viaSource === "edit");

// --- a failed cell must not be presented as a change ---
controller.threadDiffs.track(ipythonEnd("ipython:2", [{ path: path.join(workdir, "src/broken.ts"), oldStr: "x", newStr: "y" }], true));
controller.threadDiffs.post();
check("errored cell contributes nothing", (lastDiffs() ?? []).length === 1, JSON.stringify(lastDiffs()));

// --- a shell command that only READ files must not mint rows ---
fs.mkdirSync(path.join(workdir, "src"), { recursive: true });
fs.writeFileSync(path.join(workdir, "src/read-only.ts"), "// untouched\n");
controller.threadDiffs.track({ type: "tool_execution_start", toolCallId: "sh:1", toolName: "bash", args: { command: "grep -rn TODO src/read-only.ts" } });
controller.threadDiffs.track({ type: "tool_execution_end", toolCallId: "sh:1", toolName: "bash", result: {}, isError: false });
controller.threadDiffs.post();
check("a read-only shell command is never called a change", !(lastDiffs() ?? []).some((f) => f.path.includes("read-only")), JSON.stringify(lastDiffs()));

// --- resuming a thread rebuilds the panel from the session's own history ---
controller.threadDiffs.clear();
check("clear empties the panel", (lastDiffs() ?? []).length === 0);
controller.threadDiffs.rebuildFromMessages([
	{ role: "user", content: "rename it" },
	{
		role: "toolResult",
		toolCallId: "ipython:9",
		toolName: "ipython",
		content: [{ type: "text", text: "'Edited'" }],
		isError: false,
		details: { diffs: [{ path: path.join(workdir, "src/resumed.ts"), oldStr: "old", newStr: "new" }] },
	},
]);
files = lastDiffs();
check("history rehydrates the panel", files?.length === 1 && files[0].path === "src/resumed.ts", JSON.stringify(files));
// Idempotent: a second snapshot of the same thread must not double the hunks.
controller.threadDiffs.rebuildFromMessages([
	{
		role: "toolResult",
		toolCallId: "ipython:9",
		toolName: "ipython",
		content: [],
		isError: false,
		details: { diffs: [{ path: path.join(workdir, "src/resumed.ts"), oldStr: "old", newStr: "new" }] },
	},
]);
check("re-snapshotting does not duplicate hunks", lastDiffs()?.[0]?.hunks.length === 1, JSON.stringify(lastDiffs()));

// --- subagent edits, harvested from the child's own session file ---
const childFile = path.join(workdir, "sub-1.jsonl");
controller.state = { sessionFile: path.join(workdir, "root.jsonl") };
const childRecord = (target, oldStr, newStr) =>
	`${JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "ipython:1",
			toolName: "ipython",
			content: [],
			isError: false,
			details: { diffs: [{ path: path.join(workdir, target), oldStr, newStr }] },
		},
	})}\n`;
fs.writeFileSync(childFile, `${JSON.stringify({ type: "session", id: "child" })}\n${childRecord("src/child.ts", "a", "b")}`);
await controller.threadDiffs.harvestSubagents([{ sessionFile: childFile, sessionId: "child-uuid", sessionName: "verify-vault" }]);
files = lastDiffs();
const childRow = files?.find((f) => f.path === "src/child.ts");
check("subagent edits join the thread's changes", !!childRow, JSON.stringify(files?.map((f) => f.path)));
check("the subagent is named on its hunk", childRow?.hunks?.[0]?.agent === "verify-vault", JSON.stringify(childRow?.hunks));
check("the parent's own edits survive the harvest", !!files?.find((f) => f.path === "src/resumed.ts"));

// A second harvest reads only the bytes appended since the last one.
fs.appendFileSync(childFile, childRecord("src/child2.ts", "c", "d"));
await controller.threadDiffs.harvestSubagents([{ sessionFile: childFile, sessionId: "child-uuid", sessionName: "verify-vault" }]);
files = lastDiffs();
check("appended child work is picked up", !!files?.find((f) => f.path === "src/child2.ts"), JSON.stringify(files?.map((f) => f.path)));
check("the earlier child hunk is not re-read", files?.find((f) => f.path === "src/child.ts")?.hunks.length === 1);

// A rebuild of the parent's own history must not drop the subagents' work —
// that is the round trip "browse into a subagent, come back" used to break.
controller.threadDiffs.rebuildFromMessages([]);
check("subagent rows outlive a parent rebuild", !!lastDiffs()?.find((f) => f.path === "src/child.ts"), JSON.stringify(lastDiffs()?.map((f) => f.path)));

// --- the controller must still route agent events into the tracker ----------
// Calling the tracker directly (above) proves the engine; this proves the wire.
controller.threadDiffs.clear();
controller.onAgentEvent(ipythonEnd("ipython:wire", [
	{ path: path.join(workdir, "src/wired.ts"), oldStr: "before", newStr: "after" },
]));
controller.threadDiffs.post();
check("onAgentEvent routes tool diffs into the thread-diff tracker",
	(lastDiffs() ?? []).some((f) => f.path === "src/wired.ts"),
	JSON.stringify((lastDiffs() ?? []).map((f) => f.path)));

controller.dispose?.();
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nPASS thread-diffs harness" : `\n${failed} thread-diff checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
