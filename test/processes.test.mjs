/**
 * Background-process tracker gate.
 *
 * Drives src/process-tracker.ts against a real worker layout and a real spawned
 * process group shaped exactly like prime-agent's bash tool spawns one
 * (prime-agent-runtime rlm/bash.py `_status_script`), because everything the
 * panel claims is derived from those two things: the orphan journal the bash
 * tool appends to, and what `ps` says about the pid it recorded.
 *
 * The wrapper text below is verbatim from bash.py. If it drifts, the row label
 * silently degrades from the command the agent ran to a page of fd plumbing —
 * which is the failure this file exists to catch.
 */

import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
const { ProcessTracker, parsePsListing, unwrapGateCommand, readOrphanJournal } = require("./dist/process-tracker.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mirror of prime-agent's getProcessStartId, used to write a truthful record. */
function processStartId(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// macOS/BSD: fall through to ps.
	}
	try {
		const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
		return out ? `ps:${out}` : undefined;
	} catch {
		return undefined;
	}
}

// --- pure parsing, no processes involved -----------------------------------

const GATE = [
	"exec 9>&0 8>&1 0</dev/null",
	"read -r _prime_agent_gate <&9 || exit 127",
	"{",
	"codex exec --ephemeral --sandbox workspace-write '/graphify . --update'",
	"} 8>&- 9>&-",
	"__prime_status=$?",
	'exit "$__prime_status"',
].join("\n");

check(
	"the agent's command is unwrapped from the gate script",
	unwrapGateCommand(GATE) === "codex exec --ephemeral --sandbox workspace-write '/graphify . --update'",
	JSON.stringify(unwrapGateCommand(GATE)),
);
check(
	"macOS ps escapes newlines as \\012 and still unwraps",
	unwrapGateCommand(GATE.replace(/\n/g, "\\012")) ===
		"codex exec --ephemeral --sandbox workspace-write '/graphify . --update'",
);
check("a command with no gate falls back to the raw argv", unwrapGateCommand("sleep 30") === "sleep 30");

const listing = [
	"    1     1 Sun Sep  6 13:49:35 2026     /sbin/launchd",
	"  445   440 Mon Sep  7 01:02:03 2026     bash -c exec 9>&0 8>&1 0</dev/null",
	"read -r _prime_agent_gate <&9 || exit 127",
].join("\n");
const rows = parsePsListing(listing);
check("ps rows parse", rows.size === 2, `${rows.size}`);
check("lstart is captured verbatim", rows.get(1)?.lstart === "Sun Sep  6 13:49:35 2026", rows.get(1)?.lstart);
check(
	"a raw newline continues the previous row instead of inventing a process",
	rows.get(445)?.args.includes("_prime_agent_gate"),
	rows.get(445)?.args,
);

// --- a real worker layout and a real process group --------------------------

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-processes-"));
const sessionsDir = path.join(agentDir, "sessions");
const workerDir = path.join(agentDir, "daemon-workers", "w0");
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(workerDir, { recursive: true });
const sessionFile = path.join(sessionsDir, "11111111-2222-3333-4444-555555555555.jsonl");
fs.writeFileSync(sessionFile, "");
const journal = path.join(workerDir, "worker0.orphans.jsonl");
fs.writeFileSync(
	path.join(workerDir, "worker0.json"),
	JSON.stringify({
		version: 1,
		workerId: "worker0",
		// The test process stands in for the worker: the tracker refuses a
		// descriptor whose process is gone, and this one is provably alive.
		pid: process.pid,
		orphanProcessJournalPath: journal,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		createCommand: { sessionPath: sessionFile },
	}),
);
// The worker enrols the IPython kernel in this same journal. A real journal
// always has this record and the panel must never present the agent's own
// runtime as a command the agent started.
fs.writeFileSync(
	journal,
	`${JSON.stringify({
		version: 1,
		pid: process.pid,
		ownerPid: process.pid,
		processStartId: processStartId(process.pid),
		active: true,
		recordedAt: new Date().toISOString(),
	})}\n`,
);

const logFile = path.join(agentDir, "job.log");
const command = `printf 'first line\\nsecond line\\n' >> '${logFile}'; sleep 45 >> '${logFile}' 2>&1`;
const script = [
	"exec 9>&0 8>&1 0</dev/null",
	"read -r _prime_agent_gate <&9 || exit 127",
	"{",
	command,
	"} 8>&- 9>&-",
	"__prime_status=$?",
	'exit "$__prime_status"',
].join("\n");

// detached: a process group of its own, exactly like bash.py's spawn.
const child = spawn("/bin/bash", ["-c", script], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
child.stdout?.resume();
child.stderr?.resume();
// Open the gate the way the kernel does, once the pid is journaled.
fs.appendFileSync(
	journal,
	`${JSON.stringify({
		version: 1,
		pid: child.pid,
		ownerPid: process.pid,
		kernelPid: process.pid,
		processStartId: processStartId(child.pid),
		active: true,
		recordedAt: new Date().toISOString(),
	})}\n`,
);
child.stdin?.write("\n");

const tracker = new ProcessTracker();
const lookup = { sessionFile, agentDir };

await sleep(900);
let snapshot = await tracker.refresh(lookup, { streaming: false });
check("the running command earns a row once the agent is idle", snapshot.length === 1, JSON.stringify(snapshot));
check(
	"the kernel's own record is not presented as work the agent started",
	!snapshot.some((entry) => entry.pid === process.pid),
	JSON.stringify(snapshot.map((entry) => entry.pid)),
);
const row = snapshot[0];
check("the row is running", row?.state === "running", row?.state);
check("the row names the agent's command, not the gate", row?.command.startsWith("printf 'first line"), row?.command);
check("the row carries the real pid", row?.pid === child.pid, `${row?.pid} vs ${child.pid}`);

const preview = await tracker.preview(row.ref, 100);
check("the preview reads the file the command writes", preview.lines.length === 2, JSON.stringify(preview));
check("the preview shows the command's own output", preview.lines[0] === "first line", preview.lines[0]);
check("the preview names its source file", preview.source === logFile || preview.source?.endsWith("job.log"), preview.source);

const unknown = await tracker.preview("not-a-ref");
check("an unknown ref is refused, not guessed at", unknown.lines.length === 0 && !!unknown.note, JSON.stringify(unknown));

// --- the command ends: the row becomes a receipt ----------------------------

try {
	process.kill(-child.pid, "SIGKILL");
} catch {
	child.kill("SIGKILL");
}
await sleep(400);
fs.appendFileSync(
	journal,
	`${JSON.stringify({
		version: 1,
		pid: child.pid,
		ownerPid: process.pid,
		active: false,
		recordedAt: new Date().toISOString(),
	})}\n`,
);

snapshot = await tracker.refresh(lookup, { streaming: false });
check("the finished command keeps its row", snapshot.length === 1, JSON.stringify(snapshot));
check("the finished row says exited", snapshot[0]?.state === "exited", snapshot[0]?.state);
check("the finished row carries an end time", typeof snapshot[0]?.endedMs === "number");
check(
	"a finished row still previews the file it wrote",
	(await tracker.preview(snapshot[0].ref, 100)).lines.length === 2,
);

tracker.clearFinished();
check("finished receipts clear when the next turn starts", (await tracker.refresh(lookup, { streaming: true })).length === 0);

// --- journal reading is scoped to the worker that wrote it ------------------

const scoped = readOrphanJournal(journal, process.pid);
check("journal records are read for this worker", scoped.size === 2, `${scoped.size}`);
check("another worker's records are ignored", readOrphanJournal(journal, process.pid + 1).size === 0);

// --- an unreadable journal must never read as "everything finished" ---------

const blind = new ProcessTracker();
const kept = await blind.refresh({ sessionFile: path.join(sessionsDir, "missing.jsonl"), agentDir }, { streaming: false });
check("no worker means no claim", Array.isArray(kept) && kept.length === 0);

fs.rmSync(agentDir, { recursive: true, force: true });
console.log(failed === 0 ? "\nprocesses: all checks passed" : `\nprocesses: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
