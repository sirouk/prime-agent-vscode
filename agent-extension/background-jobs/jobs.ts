/**
 * Background job manager: the process-owning half of the Prime Agent extension.
 *
 * Deliberately free of any prime-agent import so it can be tested on its own —
 * index.ts is the only file that knows what an ExtensionAPI is.
 *
 * Owning the child process is the entire point. Prime Agent's own `bash()` keeps
 * a command's output in a buffer inside the IPython kernel and tells nobody when
 * it ends, so a job the agent stops awaiting becomes invisible: no exit code, no
 * output, and no way to stop it. Here the job is a child of the agent process,
 * so the exit code is delivered by the OS, the output is a file anyone can read
 * (including a UI that is not this process), and killing it is a signal to a
 * process group we created on purpose.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What a client is told about a job. Serialized verbatim into tool results. */
export interface JobRecord {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	state: "running" | "exited";
	startedMs: number;
	endedMs?: number;
	exitCode?: number;
	/** Signal that ended it, when it did not exit on its own. */
	signal?: string;
	/**
	 * Absolute path of the job's combined stdout/stderr.
	 *
	 * Published on purpose: it is what lets a UI show output without asking this
	 * process for it, and what lets the agent read a job it never awaited. The
	 * file outlives the job and the session.
	 */
	logPath: string;
}

export interface StartOptions {
	command: string;
	cwd: string;
	/** Shell to run the command with. Defaults to the platform shell. */
	shell?: string;
	env?: NodeJS.ProcessEnv;
}

const MAX_TAIL_BYTES = 256 * 1024;
const DEFAULT_TAIL_LINES = 100;
/** Grace between the polite signal and the one that cannot be refused. */
const KILL_GRACE_MS = 5_000;
/** How often the drain probe re-checks a group that outlived its shell. */
const GROUP_DRAIN_POLL_MS = 500;

interface Job {
	record: JobRecord;
	child: ChildProcess;
	logFd: number;
	killTimer?: ReturnType<typeof setTimeout>;
	/** Drain probe for a job whose shell exited while its group is still alive. */
	groupTimer?: ReturnType<typeof setInterval>;
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** Where job logs live. Under the agent dir so they are findable and prunable. */
export function defaultLogDir(): string {
	const configured = process.env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || process.env.PRIME_AGENT_DIR?.trim();
	const agentDir = configured ? path.resolve(configured) : path.join(os.homedir(), ".prime", "agent");
	return path.join(agentDir, "background-jobs");
}

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly finished: JobRecord[] = [];
	private readonly listeners = new Set<(record: JobRecord) => void>();

	constructor(private readonly logDir: string = defaultLogDir()) {}

	/** Called with the final record every time a job ends, however it ended. */
	onExit(listener: (record: JobRecord) => void): void {
		this.listeners.add(listener);
	}

	start(options: StartOptions): JobRecord {
		const id = shortId();
		fs.mkdirSync(this.logDir, { recursive: true });
		const logPath = path.join(this.logDir, `${id}.log`);
		// The child writes straight to the file descriptor, so output is captured
		// by the OS whether or not this process is alive to pump a pipe — the
		// failure mode that loses a background job's output everywhere else.
		const logFd = fs.openSync(logPath, "a", 0o600);
		const shell = options.shell ?? (process.platform === "win32" ? "cmd.exe" : "/bin/bash");
		const args = process.platform === "win32" ? ["/c", options.command] : ["-c", options.command];
		const child = spawn(shell, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			// Its own process group: the unit we can signal as a whole, so a job that
			// spawned children of its own dies completely rather than in part.
			detached: process.platform !== "win32",
			stdio: ["ignore", logFd, logFd],
		});
		const record: JobRecord = {
			id,
			command: options.command,
			cwd: options.cwd,
			...(child.pid === undefined ? {} : { pid: child.pid }),
			state: "running",
			startedMs: Date.now(),
			logPath,
		};
		const job: Job = { record, child, logFd };
		this.jobs.set(id, job);
		child.on("exit", (code, signal) => this.onShellExit(job, code, signal));
		child.on("error", (error) => {
			this.appendLog(job, `\n[background] failed to start: ${error.message}\n`);
			this.settle(job, null, null);
		});
		return { ...record };
	}

	list(): JobRecord[] {
		return [...[...this.jobs.values()].map((job) => ({ ...job.record })), ...this.finished.map((record) => ({ ...record }))];
	}

	get(id: string): JobRecord | undefined {
		const live = this.jobs.get(id);
		if (live) return { ...live.record };
		return this.finished.find((record) => record.id === id);
	}

	/** Last `lines` lines of the job's log, read from the tail of the file. */
	output(id: string, lines = DEFAULT_TAIL_LINES): { lines: string[]; truncated: boolean } | undefined {
		const record = this.get(id);
		if (!record) return undefined;
		return tailFile(record.logPath, lines);
	}

	/**
	 * Stop a job. Signals the whole process group, then escalates once, because a
	 * shell that ignores TERM would otherwise leave the job running behind a UI
	 * that has already reported it stopped.
	 */
	kill(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		this.signal(job, "SIGTERM");
		if (job.killTimer) clearTimeout(job.killTimer);
		job.killTimer = setTimeout(() => {
			if (this.jobs.has(id)) this.signal(job, "SIGKILL");
		}, KILL_GRACE_MS);
		// The timer must never hold the agent open past its own shutdown.
		job.killTimer.unref?.();
		return true;
	}

	/**
	 * Stop everything still running. Called at session end: a job started through
	 * this tool is owned by this agent, and leaving it behind would recreate the
	 * orphan problem the tool exists to solve.
	 */
	killAll(): void {
		for (const id of [...this.jobs.keys()]) this.kill(id);
	}

	private signal(job: Job, signal: NodeJS.Signals): void {
		const pid = job.child.pid;
		if (pid === undefined) return;
		// Windows has no process groups: child.kill() terminates only cmd.exe and
		// leaves the job's real command, and anything it spawned, running.
		// taskkill /T walks the tree under the pid instead.
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			// A missing taskkill surfaces as an 'error' event, which would crash
			// this process if nobody listened for it.
			killer.on("error", () => {});
			return;
		}
		try {
			// Negative pid addresses the group we created; a bare pid would leave
			// the job's own children running.
			process.kill(-pid, signal);
		} catch {
			// Already gone, or no longer ours. The exit handler settles it either way.
		}
	}

	/**
	 * The shell exiting is not the job finishing: `cmd &` leaves the real work
	 * running in the job's process group after the shell returns. Settling then
	 * would both report the shell's exit code as the job's and drop the job from
	 * the killable set while the work still runs — the exact orphan this manager
	 * exists to prevent. Keep the job live until the group drains. POSIX only:
	 * Windows has no process groups to probe.
	 */
	private onShellExit(job: Job, code: number | null, signal: NodeJS.Signals | string | null): void {
		const pgid = job.child.pid;
		if (process.platform !== "win32" && pgid !== undefined && this.groupAlive(pgid)) {
			if (job.groupTimer) clearTimeout(job.groupTimer);
			job.groupTimer = setInterval(() => {
				if (!this.jobs.has(job.record.id) || !this.groupAlive(pgid)) this.settle(job, code, signal);
			}, GROUP_DRAIN_POLL_MS);
			// A job backgrounded on purpose can outlive the agent; the probe must
			// never hold the process open.
			job.groupTimer.unref?.();
			return;
		}
		this.settle(job, code, signal);
	}

	/** Whether any process still lives in the job's process group. */
	private groupAlive(pgid: number): boolean {
		try {
			process.kill(-pgid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private settle(job: Job, code: number | null, signal: NodeJS.Signals | string | null): void {
		if (!this.jobs.has(job.record.id)) return;
		this.jobs.delete(job.record.id);
		if (job.killTimer) clearTimeout(job.killTimer);
		if (job.groupTimer) clearInterval(job.groupTimer);
		try {
			fs.closeSync(job.logFd);
		} catch {
			// Closing twice is not an error worth reporting to the agent.
		}
		job.record.state = "exited";
		job.record.endedMs = Date.now();
		if (code !== null) job.record.exitCode = code;
		if (signal) job.record.signal = String(signal);
		const record = { ...job.record };
		this.finished.push(record);
		for (const listener of this.listeners) {
			try {
				listener(record);
			} catch {
				// One bad listener must not strand the others or the job record.
			}
		}
	}

	private appendLog(job: Job, text: string): void {
		try {
			fs.writeSync(job.logFd, text);
		} catch {
			// The log is best-effort once the descriptor is closing.
		}
	}
}

/** Last `maxLines` lines of a file, read from the end so size does not matter. */
export function tailFile(file: string, maxLines: number): { lines: string[]; truncated: boolean } | undefined {
	// `slice(-maxLines)` inverts for 0 and negatives: 0 returns the whole window
	// and a negative skips from the head. Clamp so a bad `lines` can only shrink
	// the answer, never blow the 256 KiB context budget.
	const boundedLines = Math.max(1, Math.floor(maxLines));
	let handle: number | undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return undefined;
		const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
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
		const lines = all.slice(-boundedLines);
		return { lines, truncated: start > 0 || all.length > lines.length };
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {
				// The read already succeeded or already failed.
			}
		}
	}
}
