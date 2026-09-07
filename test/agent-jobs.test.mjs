/**
 * Agent-job index gate: the host half of the background-jobs contract.
 *
 * The payloads below are the ones agent-extension/background-jobs actually
 * publishes — a `background` tool result on start, and a `role: "custom"`
 * message with `customType: "background-job"` on finish. This file is the place
 * that contract is pinned from the extension's side; the extension's own test
 * pins the process behaviour.
 */

import { createRequire } from "node:module";

const require = createRequire(process.cwd() + "/");
const { AgentJobIndex, parseJobRecord, BACKGROUND_JOB_TYPE } = require("./dist/agent-jobs.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const started = {
	id: "job1",
	command: "npm run build:all",
	cwd: "/repo",
	pid: 4242,
	state: "running",
	startedMs: 1_700_000_000_000,
	logPath: "/tmp/jobs/job1.log",
};
const finished = { ...started, state: "exited", endedMs: started.startedMs + 90_000, exitCode: 0 };

const toolResultEvent = (job) => ({
	type: "tool_execution_end",
	toolCallId: "t1",
	toolName: "background",
	result: { content: [{ type: "text", text: "Started" }], details: { job } },
	isError: false,
});
const completionMessage = (job) => ({
	role: "custom",
	customType: BACKGROUND_JOB_TYPE,
	content: `Background job ${job.id} finished`,
	display: true,
	details: { job },
});

// --- start, from the tool result -------------------------------------------

const index = new AgentJobIndex();
check("a background tool result registers the job", index.track(toolResultEvent(started)) === true);
let rows = index.snapshot();
check("one row is published", rows.length === 1, JSON.stringify(rows));
check("the row is running", rows[0].state === "running");
check("the row names the command", rows[0].command === "npm run build:all", rows[0].command);
check("the row is marked as agent-owned", rows[0].source === "agent", rows[0].source);
check("a running agent job offers a stop", rows[0].killable === true);
check("an agent job always has output to read", rows[0].hasOutput === true);
check("no exit status is claimed while it runs", rows[0].exitCode === undefined && rows[0].signal === undefined);
check("the same payload again is not a change", index.track(toolResultEvent(started)) === false);

const ref = rows[0].ref;
check("the ref resolves to the job id", index.jobIdForRef(ref) === "job1");
check("the ref resolves to the published log", index.logPathForRef(ref) === "/tmp/jobs/job1.log");
check("an unknown ref resolves to nothing", index.logPathForRef("nope") === undefined);
check("the pid is claimed so an observed row cannot duplicate it", index.knownPids().has(4242));

// --- finish, from the custom message the extension injects ------------------

check(
	"the completion message updates the job",
	index.track({ type: "message_end", message: completionMessage(finished) }) === true,
);
rows = index.snapshot();
check("the row is now exited", rows[0].state === "exited", rows[0].state);
check("the exit code survives to the panel", rows[0].exitCode === 0, JSON.stringify(rows[0]));
check("the ref is stable across the transition", rows[0].ref === ref);
check("a finished job offers no stop", rows[0].killable === undefined);
check("the pid is released once it ends", !index.knownPids().has(4242));

// A snapshot replaying the thread must not resurrect a job that already ended.
check("a stale start cannot resurrect a finished job", index.track(toolResultEvent(started)) === false);
check("the row stays exited", index.snapshot()[0].state === "exited");

// --- a killed job reports the signal, not a clean exit ----------------------

const killedIndex = new AgentJobIndex();
killedIndex.track(toolResultEvent({ ...started, id: "job2" }));
killedIndex.track({
	type: "agent_end",
	messages: [completionMessage({ ...started, id: "job2", state: "exited", endedMs: 1, signal: "SIGTERM" })],
});
check("a killed job reports its signal", killedIndex.snapshot()[0].signal === "SIGTERM", JSON.stringify(killedIndex.snapshot()[0]));

// --- rebuilding from a transcript alone ------------------------------------

const resumed = new AgentJobIndex();
const transcript = [
	{ role: "user", content: "build it" },
	{ role: "toolResult", toolName: "background", toolCallId: "t1", content: [], details: { job: started } },
	completionMessage(finished),
	{ role: "assistant", content: [{ type: "text", text: "done" }] },
];
check("a resumed thread rebuilds the panel from messages alone", resumed.rebuildFromMessages(transcript) === true);
check("and lands on the finished state", resumed.snapshot()[0]?.exitCode === 0, JSON.stringify(resumed.snapshot()));

// --- per-turn and per-session resets ---------------------------------------

resumed.clearFinished();
check("finished receipts clear at the start of a turn", resumed.snapshot().length === 0);
const live = new AgentJobIndex();
live.track(toolResultEvent(started));
live.clearFinished();
check("a running job survives the turn reset", live.snapshot().length === 1);
live.clear();
check("a session switch drops everything", live.snapshot().length === 0);

// --- payloads from another process are validated, never trusted -------------

check("a non-object is rejected", parseJobRecord(undefined) === undefined);
check("a record with no id is rejected", parseJobRecord({ ...started, id: "" }) === undefined);
check("a record with no log path is rejected", parseJobRecord({ ...started, logPath: 123 }) === undefined);
check("a record with a bogus state is rejected", parseJobRecord({ ...started, state: "sideways" }) === undefined);
check("a non-integer pid is dropped rather than rendered", parseJobRecord({ ...started, pid: 1.5 })?.pid === undefined);
check("a valid record survives", parseJobRecord(started)?.id === "job1");

const noise = new AgentJobIndex();
check(
	"a custom message from another extension is ignored",
	noise.track({ type: "message_end", message: { role: "custom", customType: "something-else", details: { job: started } } }) === false,
);
check(
	"another tool's result is ignored",
	noise.track({ type: "tool_execution_end", toolName: "ipython", result: { details: { job: started } } }) === false,
);
check("nothing was registered from either", noise.snapshot().length === 0);

console.log(failed === 0 ? "\nagent-jobs: all checks passed" : `\nagent-jobs: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
