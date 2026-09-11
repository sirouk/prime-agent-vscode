/**
 * Background processes the agent started and that are still alive.
 *
 * prime-agent's bash tool (prime-agent-runtime `rlm/bash.py`) journals every
 * process group it spawns to `<workerId>.orphans.jsonl`: one append when the
 * group is enrolled and another when it is reaped, each carrying the pid, the
 * owning worker's pid and a `processStartId` that pins the pid to one process.
 * The daemon reads it to reap strays it lost; we read it because it is the only
 * authoritative list of what the agent started. Nothing here writes to the
 * journal, signals a process, or touches the agent's pipes.
 *
 * What this deliberately CANNOT do is read a command's own output. bash.py keeps
 * stdout in a `_BoundedBuffer` inside the kernel process — memory, never disk —
 * and nothing pushes it anywhere: `_report`/`_watch` only set the handle's own
 * state, and the sole done-callback wakes a coroutine that is already awaiting.
 * A background handle the agent stopped awaiting therefore delivers its output
 * to nobody until the agent reads that handle in a later turn. Reading the pipe
 * ourselves would take those bytes from the agent, so the only output we can
 * honestly preview is what the command itself wrote to a file, found by
 * resolving its open descriptors. When there is no such file we say so rather
 * than showing an empty box that reads as "no output".
 *
 * POSIX only: the identity, group and descriptor queries here are `ps`/`lsof`
 * and `/proc`. On Windows the tracker reports nothing at all.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveWorkerDescriptor, type OwnerLookup } from "./daemon-owner.js";
import type { ProcessOutputPreview, SessionProcess } from "./protocol.js";

/**
 * How long a command must run before it earns a row while the agent is
 * streaming. The panel exists to show work the transcript does NOT already
 * account for; every `ls` the agent runs is already on screen as a tool call.
 * Once the turn ends the delay stops applying — an agent that is idle explains
 * nothing, so anything still alive is exactly what the operator came here for.
 */
const PROMOTE_MS = 8_000;
/** Finished rows are a receipt, not a log. They clear on the next turn anyway. */
const MAX_FINISHED = 20;
/** Bound on group members we inspect for output files. */
const MAX_GROUP_MEMBERS = 8;
/** Tail window. 64 KiB of a log is far more than the ~100 lines we render. */
const PREVIEW_BYTES = 64 * 1024;
const MAX_PREVIEW_LINES = 200;
const PS_TIMEOUT_MS = 4_000;

/** One line of `<workerId>.orphans.jsonl` (core/orphan-process-journal.ts). */
interface OrphanRecord {
	version?: number;
	pid?: number;
	ownerPid?: number;
	kernelPid?: number;
	processStartId?: string;
	active?: boolean;
	recordedAt?: string;
}

interface PsRow {
	pid: number;
	pgid: number;
	/** `ps -o lstart=`, verbatim; the second half of a `ps:` process start id. */
	lstart: string;
	args: string;
}

interface Tracked {
	/** Opaque host-issued capability. The webview never names a pid or a path. */
	ref: string;
	pid: number;
	startId?: string;
	startedMs: number;
	endedMs?: number;
	/** The command the agent asked for, unwrapped from the gate script. */
	command: string;
	/** Files this process (or a member of its group) writes, when it has any. */
	outputPaths: string[];
	outputResolved: boolean;
	/** Once true the row is on screen and stays there through to its receipt. */
	promoted: boolean;
}

function execFileText(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
			resolve(typeof stdout === "string" ? stdout : "");
		});
	});
}

/**
 * Mirror of prime-agent's `getProcessStartId` (core/session-lease.ts): `/proc`
 * first, then `ps`. It has to match byte for byte — the string is compared
 * against what the journal recorded, and a different derivation would read every
 * live process as a recycled pid.
 */
function procStartId(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const startTime = stat.slice(commandEnd + 2).split(" ")[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// Not Linux, or the process is gone. The ps listing answers instead.
	}
	return undefined;
}

function startIdFromRow(pid: number, row: PsRow | undefined): string | undefined {
	return procStartId(pid) ?? (row ? `ps:${row.lstart}` : undefined);
}

/**
 * Parse `ps -axww -o pid=,pgid=,lstart=,args=`.
 *
 * A command can contain newlines — the bash gate script always does — and
 * platforms disagree on whether ps escapes them (macOS prints `\012`, some
 * others print the byte). A line only starts a new row when it opens with the
 * pid/pgid/lstart shape, so a raw newline continues the previous row's args
 * instead of inventing a process.
 */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

export function parsePsListing(stdout: string): Map<number, PsRow> {
	const rows = new Map<number, PsRow>();
	let current: PsRow | undefined;
	for (const line of stdout.split("\n")) {
		const match = PS_ROW.exec(line);
		if (match) {
			current = { pid: Number(match[1]), pgid: Number(match[2]), lstart: match[3].trim(), args: match[4] };
			rows.set(current.pid, current);
			continue;
		}
		if (current) current.args += `\n${line}`;
	}
	return rows;
}

/**
 * The command the agent actually asked for, dug out of bash.py's gate script:
 *
 *     exec 9>&0 8>&1 0</dev/null
 *     read -r _prime_agent_gate <&9 || exit 127
 *     { <the command> } 8>&- 9>&-
 *     __prime_status=$? ...
 *
 * Falls back to the raw argv, which is ugly but true. Never throws: a wrapper
 * that changes shape must degrade to "we show you what ps says", not to a blank
 * row or a crash.
 */
export function unwrapGateCommand(args: string): string {
	const text = args.replace(/\\012/g, "\n");
	const gate = /read -r _prime_agent_gate <&\d+ \|\| exit \d+\s*/.exec(text);
	if (!gate) return text.trim();
	const body = text.slice(gate.index + gate[0].length).replace(/^\s*\{\s*/, "");
	const close = /\n\}\s*\d+>&-\s*\d+>&-/.exec(body);
	return (close ? body.slice(0, close.index) : body).trim() || text.trim();
}

/** One line, for the row. The full text stays available for the tooltip. */
export function shortCommandLabel(command: string, max = 96): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Latest record per pid, restricted to the worker that owns this journal. */
export function readOrphanJournal(file: string, ownerPid: number): Map<number, OrphanRecord> {
	const latest = new Map<number, OrphanRecord>();
	let contents: string;
	try {
		contents = fs.readFileSync(file, "utf8");
	} catch {
		return latest;
	}
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			const record = JSON.parse(line) as OrphanRecord;
			if (record.version !== 1) continue;
			if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) continue;
			if (record.ownerPid !== ownerPid) continue;
			if (typeof record.active !== "boolean") continue;
			latest.set(record.pid as number, record);
		} catch {
			// A crash can truncate only the final append.
		}
	}
	return latest;
}

function isRegularFile(file: string): fs.Stats | undefined {
	try {
		const stat = fs.statSync(file);
		return stat.isFile() ? stat : undefined;
	} catch {
		return undefined;
	}
}

/** Absolute paths a process holds open on its low descriptors, as regular files. */
async function openOutputFiles(pid: number): Promise<string[]> {
	const found: string[] = [];
	// Linux: the descriptors are right there, no subprocess needed.
	try {
		const dir = `/proc/${pid}/fd`;
		for (const entry of fs.readdirSync(dir)) {
			const fd = Number(entry);
			if (!Number.isInteger(fd) || fd > 9) continue;
			try {
				const target = fs.readlinkSync(path.join(dir, entry));
				if (target.startsWith("/") && !target.startsWith("/dev/") && isRegularFile(target)) found.push(target);
			} catch {
				// Descriptor closed between readdir and readlink.
			}
		}
		return found;
	} catch {
		// Not Linux (or no /proc): ask lsof for the same descriptors.
	}
	const stdout = await execFileText("lsof", ["-p", String(pid), "-a", "-d", "0-9", "-F", "ftn"]);
	let type = "";
	for (const line of stdout.split("\n")) {
		if (line.startsWith("t")) type = line.slice(1);
		else if (line.startsWith("n") && type === "REG") {
			const name = line.slice(1);
			if (name.startsWith("/") && !name.startsWith("/dev/") && isRegularFile(name)) found.push(name);
		}
	}
	return found;
}

/** Last `maxLines` lines of a file, read from the tail so size does not matter. */
export function tailFile(file: string, maxLines: number): { lines: string[]; truncated: boolean } | undefined {
	let handle: number | undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return undefined;
		const start = Math.max(0, stat.size - PREVIEW_BYTES);
		const length = stat.size - start;
		if (length <= 0) return { lines: [], truncated: false };
		const buffer = Buffer.alloc(length);
		handle = fs.openSync(file, "r");
		const read = fs.readSync(handle, buffer, 0, length, start);
		let text = buffer.subarray(0, read).toString("utf8");
		// A window that starts mid-file almost always starts mid-line.
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		const all = text.split("\n");
		if (all.length > 0 && all[all.length - 1] === "") all.pop();
		const lines = all.slice(-maxLines).map(stripControl);
		return { lines, truncated: start > 0 || all.length > lines.length };
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {
				// Nothing to do; the read already succeeded or already failed.
			}
		}
	}
}

/** ANSI and stray control bytes would render as garbage in the webview. */
function stripControl(line: string): string {
	return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export class ProcessTracker {
	private tracked = new Map<number, Tracked>();
	private byRef = new Map<string, Tracked>();
	/** Last snapshot, replayed unchanged when a refresh cannot read the journal. */
	private lastSnapshot: SessionProcess[] = [];

	constructor(private readonly log?: (line: string) => void) {}

	/** Number of rows currently reported as running; drives the poll cadence. */
	get runningCount(): number {
		return this.lastSnapshot.filter((entry) => entry.state === "running").length;
	}

	/** Forget everything. Used when the session on screen changes. */
	reset(): void {
		this.tracked.clear();
		this.byRef.clear();
		this.lastSnapshot = [];
	}

	/**
	 * Drop the finished receipts, keeping whatever is still running. Called at
	 * `agent_start`, so a new turn opens with the panel describing only itself.
	 */
	clearFinished(): void {
		for (const [pid, entry] of [...this.tracked]) {
			if (entry.endedMs === undefined) continue;
			this.tracked.delete(pid);
			this.byRef.delete(entry.ref);
		}
		this.lastSnapshot = this.snapshot();
	}

	async refresh(lookup: OwnerLookup, options: { streaming: boolean; skipPids?: ReadonlySet<number> }): Promise<SessionProcess[]> {
		if (process.platform === "win32") return [];
		const descriptor = resolveWorkerDescriptor(lookup);
		const journal = descriptor?.orphanProcessJournalPath;
		// No worker, no journal, or a journal we cannot read is "we did not learn
		// anything this cycle" — never "everything finished".
		if (!descriptor?.pid || !journal || !fs.existsSync(journal)) return this.lastSnapshot;
		const records = readOrphanJournal(journal, descriptor.pid);
		// A journal holding only the kernel's own record is the normal resting
		// state; there is nothing to look up in ps for it.
		if (![...records.values()].some(isAgentSpawned) && this.tracked.size === 0) return this.lastSnapshot;

		const rows = parsePsListing(await execFileText("ps", ["-axww", "-o", "pid=,pgid=,lstart=,args="]));
		const now = Date.now();
		const seen = new Set<number>();

		for (const [pid, record] of records) {
			if (!isAgentSpawned(record)) continue;
			// A job the extension owns is already described in full — with its exit
			// code and its own log — so reconstructing a second, poorer row for the
			// same process would only disagree with it.
			if (options.skipPids?.has(pid)) continue;
			seen.add(pid);
			const row = rows.get(pid);
			const alive = record.active === true && !!row && identityMatches(pid, row, record.processStartId);
			let entry = this.tracked.get(pid);
			if (!entry) {
				// Only enroll a process we can actually describe. One that started and
				// finished between two polls has no argv left to read, and a row that
				// cannot say what ran is worse than no row.
				if (!alive) continue;
				entry = {
					ref: randomUUID(),
					pid,
					startId: record.processStartId,
					startedMs: Date.parse(record.recordedAt ?? "") || now,
					command: unwrapGateCommand(row!.args),
					outputPaths: [],
					outputResolved: false,
					promoted: false,
				};
				this.tracked.set(pid, entry);
				this.byRef.set(entry.ref, entry);
			}
			if (alive) {
				entry.endedMs = undefined;
				if (!entry.promoted && (!options.streaming || now - entry.startedMs >= PROMOTE_MS)) {
					entry.promoted = true;
					// One resolution per process, at the moment it earns its row: the
					// descriptors are gone by the time the operator clicks a finished one.
					void this.resolveOutputs(entry, rows).catch(() => undefined);
				}
			} else if (entry.endedMs === undefined) {
				entry.endedMs = Date.parse(record.recordedAt ?? "") || now;
			}
		}

		// A pid the journal no longer mentions (rotated away, or a worker that
		// replaced its journal) is over as far as we can tell.
		for (const [pid, entry] of this.tracked) {
			if (seen.has(pid) || entry.endedMs !== undefined) continue;
			entry.endedMs = now;
		}

		this.prune();
		this.lastSnapshot = this.snapshot();
		return this.lastSnapshot;
	}

	/**
	 * The last ~`maxLines` lines this command wrote to a file it opened, or an
	 * honest explanation of why we have nothing.
	 */
	/** Files this observed command writes, when we resolved any. */
	filesForRef(ref: string): string[] {
		const entry = this.byRef.get(ref);
		if (!entry) return [];
		return entry.outputPaths.filter((file) => !!isRegularFile(file));
	}

	async preview(ref: string, maxLines = 100): Promise<ProcessOutputPreview> {
		const entry = this.byRef.get(ref);
		if (!entry) return { ref, lines: [], note: "That process is no longer being tracked." };
		if (entry.endedMs === undefined) {
			// Still running: it may have opened its log after we first looked.
			const rows = parsePsListing(await execFileText("ps", ["-axww", "-o", "pid=,pgid=,lstart=,args="]));
			await this.resolveOutputs(entry, rows, true);
		}
		// A file the command wrote is the claim being made, so it has to have been
		// touched since the command started; an unrelated path that merely appears
		// on the command line is not this command's output.
		const candidates = entry.outputPaths
			.map((file) => ({ file, stat: isRegularFile(file) }))
			.filter((candidate): candidate is { file: string; stat: fs.Stats } => !!candidate.stat)
			.filter((candidate) => candidate.stat.mtimeMs >= entry.startedMs - 1_000)
			.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
		for (const candidate of candidates) {
			const tail = tailFile(candidate.file, Math.min(maxLines, MAX_PREVIEW_LINES));
			if (tail && tail.lines.length > 0) {
				return { ref, lines: tail.lines, source: candidate.file, truncated: tail.truncated };
			}
		}
		return {
			ref,
			lines: [],
			note:
				entry.endedMs === undefined
					? "This command's output is held in the agent's kernel buffer. Nothing delivers it on its own — it reaches the transcript only if the agent reads the handle in a later turn. Only output the command writes to a file can be previewed while it runs."
					: "This command left no output file to read. Whatever it printed is still in the agent's kernel buffer, and reaches the transcript only if the agent reads the handle in a later turn.",
		};
	}

	/**
	 * Files written by the process or anything else in its process group.
	 * bash.py starts each command in its own group, so the group is exactly this
	 * command's descendants — and the redirect usually lives on the real program,
	 * not on the gate shell that leads the group.
	 */
	private async resolveOutputs(entry: Tracked, rows: Map<number, PsRow>, force = false): Promise<void> {
		if (entry.outputResolved && !force) return;
		entry.outputResolved = true;
		const members = [entry.pid];
		for (const row of rows.values()) {
			if (row.pgid === entry.pid && row.pid !== entry.pid) members.push(row.pid);
			if (members.length >= MAX_GROUP_MEMBERS) break;
		}
		const found = new Set<string>(entry.outputPaths);
		for (const pid of members) {
			for (const file of await openOutputFiles(pid)) found.add(file);
		}
		entry.outputPaths = [...found];
		this.log?.(`processes: ${entry.pid} output files ${entry.outputPaths.length}`);
	}

	private prune(): void {
		const finished = [...this.tracked.values()]
			.filter((entry) => entry.endedMs !== undefined && entry.promoted)
			.sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0));
		for (const entry of finished.slice(MAX_FINISHED)) {
			this.tracked.delete(entry.pid);
			this.byRef.delete(entry.ref);
		}
		// A process that never earned a row leaves nothing behind once it is over.
		for (const [pid, entry] of [...this.tracked]) {
			if (entry.endedMs !== undefined && !entry.promoted) {
				this.tracked.delete(pid);
				this.byRef.delete(entry.ref);
			}
		}
	}

	private snapshot(): SessionProcess[] {
		return [...this.tracked.values()]
			.filter((entry) => entry.promoted)
			.sort((a, b) => {
				if ((a.endedMs === undefined) !== (b.endedMs === undefined)) return a.endedMs === undefined ? -1 : 1;
				return a.endedMs === undefined ? a.startedMs - b.startedMs : (b.endedMs ?? 0) - (a.endedMs ?? 0);
			})
			.map((entry) => ({
				ref: entry.ref,
				pid: entry.pid,
				source: "observed" as const,
				command: shortCommandLabel(entry.command),
				fullCommand: entry.command.length > 2_000 ? `${entry.command.slice(0, 2_000)}…` : entry.command,
				state: entry.endedMs === undefined ? ("running" as const) : ("exited" as const),
				startedMs: entry.startedMs,
				...(entry.endedMs === undefined ? {} : { endedMs: entry.endedMs }),
				...(entry.outputPaths.length > 0 ? { hasOutput: true as const } : {}),
			}));
	}
}

/**
 * Whether a journal record describes a command the AGENT ran.
 *
 * Two writers share this journal. The node worker enrols the IPython kernel
 * itself the moment it spawns it (core/kernel/repl-manager.ts, so the daemon can
 * reap a kernel it loses), and the bash tool inside that kernel enrols every
 * process group it starts (prime-agent-runtime rlm/bash.py `_record_journal`).
 * Only the second writer stamps `kernelPid` — it is `os.getpid()` of the kernel
 * doing the spawning — so its presence is not a heuristic but exactly the
 * statement "a kernel started this", which is what the agent running a command
 * is. Without this the panel's first and permanent row is `python -m rlm.repl`:
 * the agent's own runtime, described as work it kicked off.
 */
function isAgentSpawned(record: OrphanRecord): boolean {
	return Number.isInteger(record.kernelPid) && record.kernelPid !== record.pid;
}

function identityMatches(pid: number, row: PsRow, recorded: string | undefined): boolean {
	// A record with no identity cannot prove the pid still names the journaled
	// process. Liveness alone is the most we can claim, matching the daemon's own
	// treatment of identity-free records.
	if (!recorded) return true;
	const current = startIdFromRow(pid, row);
	return current === undefined || current === recorded;
}
