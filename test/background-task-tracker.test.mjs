/**
 * Background-task tracker gate.
 *
 * Pins the file-read adapter that feeds Prime Agent `background_task` receipts
 * into the Processes panel: where the directory lives for a root vs a subagent,
 * that a parent does not inherit child jobs, and that clicking a row can tail
 * the skill's own stdout/stderr files.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
const { BackgroundTaskTracker, backgroundTasksDir, parseTaskState } = require("./dist/background-task-tracker.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-bg-tasks-"));
const sessionsDir = path.join(agentDir, "sessions");
const parentId = "01a08f46-2bb7-75d1-844c-58a3f67f8083";
const childSessionId = "01a08f48-8dce-721a-86db-519c7fe1fcef";
const parentTaskId = "97a5daf0-17ac-49ff-baa9-f28b821880a9";
const childTaskId = "915e4bb8-2e6d-4868-b778-744de7a0f0c8";
const parentSession = path.join(sessionsDir, `${parentId}.jsonl`);
const childDir = path.join(agentDir, "session-artifacts", parentId, "sub-8e11fc25");
const childSession = path.join(childDir, `${childSessionId}.jsonl`);
const parentTasks = path.join(agentDir, "session-artifacts", parentId, "background-tasks");
const childTasks = path.join(childDir, "background-tasks");

fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(parentTasks, { recursive: true });
fs.mkdirSync(childTasks, { recursive: true });
fs.writeFileSync(parentSession, "");
fs.writeFileSync(childSession, "");

check(
	"a root session file maps to session-artifacts/<id>/background-tasks",
	backgroundTasksDir(parentSession) === parentTasks,
	backgroundTasksDir(parentSession),
);
check(
	"a subagent jsonl maps to the background-tasks dir beside it",
	backgroundTasksDir(childSession) === childTasks,
	backgroundTasksDir(childSession),
);
check("a missing session file yields no directory", backgroundTasksDir(undefined) === undefined);

function writeTask(dir, id, state, logs = {}) {
	const taskDir = path.join(dir, id);
	fs.mkdirSync(taskDir, { recursive: true });
	const record = {
		id,
		label: state.label ?? "task",
		command: state.command,
		cwd: "/repo",
		status: state.status,
		created_at: state.created_at,
		updated_at: state.created_at,
		task_dir: taskDir,
		stdout_path: path.join(taskDir, "stdout.log"),
		stderr_path: path.join(taskDir, "stderr.log"),
		...state,
	};
	fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(record));
	fs.writeFileSync(record.stdout_path, logs.stdout ?? "");
	fs.writeFileSync(record.stderr_path, logs.stderr ?? "");
	return taskDir;
}

writeTask(
	parentTasks,
	parentTaskId,
	{
		label: "ui-test-sleep-30s",
		command: ["sleep", "30"],
		status: "running",
		created_at: 1_789_110_290.5,
		started_at: 1_789_110_290.6,
		child_pid: 755242,
	},
	{ stdout: "tick\n" },
);
writeTask(
	childTasks,
	childTaskId,
	{
		label: "combo-child-sleep-30s",
		command: ["sleep", "30"],
		status: "running",
		created_at: 1_789_110_299.0,
		child_pid: 755300,
	},
	{ stdout: "child-out\n", stderr: "child-err\n" },
);

check(
	"a truncated state.json is dropped rather than half-rendered",
	parseTaskState({ id: "nope" }, parentTasks) === undefined,
);

const parent = new BackgroundTaskTracker();
let rows = parent.refresh(backgroundTasksDir(parentSession));
check("the parent panel has one row", rows.length === 1, JSON.stringify(rows));
check("the parent row is the parent job, not the child's", rows[0].fullCommand.includes("sleep 30"));
check("the parent does not list the child task id in its command", !rows[0].fullCommand.includes("combo"));
check("a running skill job is running", rows[0].state === "running");
check("skill seconds become milliseconds", rows[0].startedMs === 1_789_110_290_600, String(rows[0].startedMs));
check("the row is marked as a task receipt", rows[0].source === "task");
check("a skill job is not killable from the panel", rows[0].killable === undefined);
check("a running child_pid is claimed", parent.knownPids().has(755242));
check("runningCount follows live receipts", parent.runningCount === 1);

const parentRef = rows[0].ref;
const parentPreview = parent.preview(parentRef);
check("clicking the parent row tails stdout", parentPreview?.lines.join("\n") === "tick", JSON.stringify(parentPreview));
check("an unknown ref is not a task preview", parent.preview("nope") === undefined);
const parentLogs = parent.logFilesForRef(parentRef);
check("open-log offers stdout for a task with output", parentLogs?.length === 1 && parentLogs[0].endsWith("stdout.log"), JSON.stringify(parentLogs));
check("an unknown ref has no log files", parent.logFilesForRef("nope") === undefined);

const child = new BackgroundTaskTracker();
rows = child.refresh(backgroundTasksDir(childSession));
check("the child panel has the child job only", rows.length === 1, JSON.stringify(rows));
check("the child row is not the parent job", rows[0].pid === 755300, JSON.stringify(rows[0]));
const childPreview = child.preview(rows[0].ref);
check(
	"a job with both streams shows both tails",
	childPreview?.lines.includes("== stdout ==") &&
		childPreview.lines.includes("child-out") &&
		childPreview.lines.includes("child-err"),
	JSON.stringify(childPreview),
);
const childLogs = child.logFilesForRef(rows[0].ref);
check(
	"open-log includes stderr only when it has bytes",
	childLogs?.length === 2 && childLogs[1].endsWith("stderr.log"),
	JSON.stringify(childLogs),
);

writeTask(
	parentTasks,
	parentTaskId,
	{
		label: "ui-test-sleep-30s",
		command: ["sleep", "30"],
		status: "completed",
		created_at: 1_789_110_290.5,
		started_at: 1_789_110_290.6,
		completed_at: 1_789_110_320.65,
		exit_code: 0,
		child_pid: null,
	},
	{ stdout: "tick\n" },
);
rows = parent.refresh(backgroundTasksDir(parentSession));
check("the ref is stable after completion", rows[0].ref === parentRef);
check("a completed job is exited", rows[0].state === "exited");
check("the skill exit code reaches the panel", rows[0].exitCode === 0, JSON.stringify(rows[0]));
check("a finished pid is released", parent.knownPids().size === 0);

const emptyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
writeTask(parentTasks, emptyId, {
	command: ["true"],
	status: "completed",
	created_at: 1_789_110_400,
	completed_at: 1_789_110_401,
	exit_code: 0,
});
rows = parent.refresh(backgroundTasksDir(parentSession));
const empty = rows.find((row) => row.command === "true");
check("a silent job still occupies a row", !!empty, JSON.stringify(rows));
const emptyPreview = parent.preview(empty.ref);
check(
	"a silent job explains the empty capture instead of rendering a blank box",
	emptyPreview?.note?.includes("no output"),
	JSON.stringify(emptyPreview),
);

const junkDir = path.join(parentTasks, "not-a-uuid");
fs.mkdirSync(junkDir, { recursive: true });
fs.writeFileSync(path.join(junkDir, "state.json"), JSON.stringify({ id: "not-a-uuid", command: ["x"], status: "running", created_at: 1 }));
const before = parent.snapshot().length;
parent.refresh(backgroundTasksDir(parentSession));
check("an invalid task id is ignored", parent.snapshot().length === before);

parent.reset();
check("reset clears the panel", parent.snapshot().length === 0);
check("reset clears runningCount", parent.runningCount === 0);

fs.rmSync(agentDir, { recursive: true, force: true });
console.log(failed === 0 ? "\nPASS background-task-tracker" : `\n${failed} background-task-tracker checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
