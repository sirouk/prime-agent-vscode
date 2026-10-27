/**
 * Background job manager gate (the Prime Agent extension's process-owning half).
 *
 * Runs real commands. Everything this manager promises the agent — an exit code,
 * output that outlives the turn, a stop that actually stops — is a promise about
 * OS behaviour, so asserting it against mocks would assert nothing.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
const { JobManager } = require("./dist/background-jobs.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wait for a condition the OS reaches on its own, rather than guessing a delay. */
async function until(predicate, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return false;
}

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-jobs-"));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-jobs-cwd-"));

const exits = [];
const jobs = new JobManager(logDir);
jobs.onExit((record) => exits.push(record));

// --- a job that outlives the call, then ends on its own ---------------------

const ok = jobs.start({ command: "printf 'hello\\nworld\\n'; sleep 0.4; exit 0", cwd: workdir });
check("start returns immediately with an id and a pid", !!ok.id && typeof ok.pid === "number", JSON.stringify(ok));
check("the job starts running", ok.state === "running");
check("the job publishes a log path", ok.logPath.startsWith(logDir), ok.logPath);
check("a running job is listed", jobs.list().some((job) => job.id === ok.id && job.state === "running"));

check("output is readable while the job is still running", await until(() => (jobs.output(ok.id)?.lines.length ?? 0) >= 2));
check("output is the command's own", jobs.output(ok.id)?.lines.join("|") === "hello|world", JSON.stringify(jobs.output(ok.id)));

check("the exit is delivered", await until(() => exits.some((record) => record.id === ok.id)));
const okExit = exits.find((record) => record.id === ok.id);
check("the exit carries the real exit code", okExit?.exitCode === 0, JSON.stringify(okExit));
check("the exit carries an end time", typeof okExit?.endedMs === "number");
check("a finished job stays listed with its code", jobs.get(ok.id)?.state === "exited");
check("output survives the job", jobs.output(ok.id)?.lines.join("|") === "hello|world");

// --- a failing job reports the failure, not a shrug -------------------------

const bad = jobs.start({ command: "echo boom >&2; exit 17", cwd: workdir });
check("a failing job's code is reported", await until(() => jobs.get(bad.id)?.exitCode === 17), JSON.stringify(jobs.get(bad.id)));
check("stderr is captured too", jobs.output(bad.id)?.lines.includes("boom"), JSON.stringify(jobs.output(bad.id)));

// --- kill stops the whole group, not just the shell -------------------------

const marker = path.join(workdir, "survivor.txt");
// The inner sleep is a child of the job's shell: signalling only the shell would
// leave it running, which is the bug the process group exists to prevent.
const long = jobs.start({ command: `sleep 45 && echo survived > '${marker}'`, cwd: workdir });
check("the long job is running", await until(() => jobs.get(long.id)?.state === "running"));
const groupAlive = () => {
	try {
		process.kill(-long.pid, 0);
		return true;
	} catch {
		return false;
	}
};
check("its process group exists", process.platform === "win32" || groupAlive());
check("kill reports it acted", jobs.kill(long.id) === true);
check("the job settles as stopped", await until(() => jobs.get(long.id)?.state === "exited"));
check("the whole process group is gone", process.platform === "win32" || (await until(() => !groupAlive())));
await sleep(300);
check("the killed job never ran its second half", !fs.existsSync(marker));
const killed = jobs.get(long.id);
check("a killed job is reported as killed, not as a clean exit", killed?.signal !== undefined || killed?.exitCode !== 0, JSON.stringify(killed));

check("killing an unknown job is refused rather than faked", jobs.kill("nope") === false);
check("reading an unknown job returns nothing to show", jobs.output("nope") === undefined);

// --- a backgrounded command outlives its own shell --------------------------
// `cmd & exit 0` hands the process group to its children and leaves. The
// shell's exit event used to settle the job at once — killing the whole point
// of backgrounding. The job must stay running, listed and killable, until the
// group it created is actually gone. (POSIX only: on Windows the detached
// child is not a process-group leader, so the old rule holds there.)
if (process.platform !== "win32") {
	const bgMarker = path.join(workdir, "bg-survivor.txt");
	const bg = jobs.start({ command: `sleep 45 && echo survived > '${bgMarker}' & exit 0`, cwd: workdir });
	check("the backgrounding job starts running", bg.state === "running");
	// Wait until the shell itself is gone: at that exact moment the old code
	// had already settled the job; the new code must not have.
	const shellGone = await until(() => {
		try {
			process.kill(bg.pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 4_000);
	check("the shell of the backgrounding job has exited", shellGone === true, `state: ${jobs.get(bg.id)?.state}`);
	check("the job stays running while its group drains", jobs.get(bg.id)?.state === "running", JSON.stringify(jobs.get(bg.id)));
	check("the job is listed as running while its group drains", jobs.list().some((job) => job.id === bg.id && job.state === "running"));
	check("the draining job is still killable", jobs.kill(bg.id) === true);
	check("the job settles once the group is gone", await until(() => jobs.get(bg.id)?.state === "exited"));
	await sleep(300);
	check("the killed backgrounded job never ran its marker", !fs.existsSync(bgMarker));
}

// --- a bad `lines` cannot ask for the whole window ---------------------------
// `slice(-maxLines)` inverts for 0 and negatives: zero meant the full 256 KiB
// window and a negative skipped from the head instead of the tail.
{
	const many = jobs.start({ command: "seq 1 300", cwd: workdir });
	await until(() => jobs.get(many.id)?.state === "exited");
	const full = jobs.output(many.id, 300)?.lines ?? [];
	check("an explicit 300 reads the whole short log", full.length === 300, `${full.length}`);
	check("lines=0 is clamped to one line, not the whole window", jobs.output(many.id, 0)?.lines.length === 1, JSON.stringify(jobs.output(many.id, 0)?.lines.length));
	check("a negative lines is clamped to the tail too", jobs.output(many.id, -5)?.lines.length === 1, JSON.stringify(jobs.output(many.id, -5)?.lines.length));
	check("the clamped line is the tail, not the head", jobs.output(many.id, 0)?.lines[0] === "300", JSON.stringify(jobs.output(many.id, 0)?.lines));
}

// --- killAll is what session shutdown uses ---------------------------------

const a = jobs.start({ command: "sleep 45", cwd: workdir });
const b = jobs.start({ command: "sleep 45", cwd: workdir });
check("two more jobs are running", await until(() => jobs.get(a.id)?.state === "running" && jobs.get(b.id)?.state === "running"));
jobs.killAll();
check(
	"killAll leaves nothing running",
	await until(() => jobs.get(a.id)?.state === "exited" && jobs.get(b.id)?.state === "exited"),
	JSON.stringify([jobs.get(a.id)?.state, jobs.get(b.id)?.state]),
);
check("every job that ended produced an exit record", exits.length >= 5, `${exits.length}`);

fs.rmSync(logDir, { recursive: true, force: true });
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nbackground-jobs: all checks passed" : `\nbackground-jobs: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
