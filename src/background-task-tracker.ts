/**
 * Prime Agent `background_task` receipts for the Processes panel.
 *
 * The skill writes one directory per job under the session's
 * `background-tasks/` folder (`state.json`, `stdout.log`, `stderr.log`). That
 * is the only structured record a UI can read: there is no RPC event, no
 * daemon roster row, and the bash orphan journal never sees the detached
 * runner. This module is the file-read adapter — the same class of thing as
 * process-tracker.ts reading `<workerId>.orphans.jsonl`.
 *
 * Scope is the session on screen. A root session file
 * `<agentDir>/sessions/<id>.jsonl` maps to
 * `<agentDir>/session-artifacts/<id>/background-tasks/`. A subagent's jsonl
 * already lives in its `RLM_SESSION_DIR`, so the jobs sit next to it. Child
 * jobs are therefore invisible on the parent, which matches `list_tasks()`.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ProcessOutputPreview, SessionProcess } from "./protocol.js";
import { shortCommandLabel, tailFile } from "./process-tracker.js";

const LIVE = new Set(["starting", "running"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "launch_failed"]);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Finished rows are a receipt, not a log. */
const MAX_FINISHED = 20;
const MAX_PREVIEW_LINES = 200;

export interface BackgroundTaskRecord {
	id: string;
	command: string[];
	label?: string;
	status: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	exitCode?: number;
	pid?: number;
	taskDir: string;
	stdoutPath: string;
	stderrPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (!value.every((item) => typeof item === "string" && item)) return undefined;
	return value;
}

/** Skill receipts use `time.time()` seconds. */
function toMs(epoch: number): number {
	return Math.round(epoch * 1000);
}

function pathInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * Directory that holds this session's `background_task` receipts, or undefined
 * when we cannot name one from the session file alone.
 */
export function backgroundTasksDir(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const resolved = path.resolve(sessionFile);
	if (path.extname(resolved) !== ".jsonl") return undefined;
	const dir = path.dirname(resolved);
	const id = path.basename(resolved, ".jsonl");
	if (!id || id.startsWith(".")) return undefined;
	if (path.basename(dir) === "sessions") {
		return path.join(path.dirname(dir), "session-artifacts", id, "background-tasks");
	}
	return path.join(dir, "background-tasks");
}

/**
 * Parse one skill `state.json`. A record that fails is dropped rather than
 * half-rendered: this file is written by another process and may be mid-replace.
 */
export function parseTaskState(value: unknown, fallbackDir: string): BackgroundTaskRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { id, command, status } = value;
	if (typeof id !== "string" || !TASK_ID.test(id)) return undefined;
	const argv = asStringArray(command);
	if (!argv) return undefined;
	if (typeof status !== "string" || (!LIVE.has(status) && !TERMINAL.has(status))) return undefined;
	if (typeof value.created_at !== "number" || !Number.isFinite(value.created_at)) return undefined;
	const taskDir =
		typeof value.task_dir === "string" && value.task_dir ? path.resolve(value.task_dir) : path.resolve(fallbackDir);
	const stdoutPath =
		typeof value.stdout_path === "string" && value.stdout_path
			? path.resolve(value.stdout_path)
			: path.join(taskDir, "stdout.log");
	const stderrPath =
		typeof value.stderr_path === "string" && value.stderr_path
			? path.resolve(value.stderr_path)
			: path.join(taskDir, "stderr.log");
	return {
		id,
		command: argv,
		...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim() } : {}),
		status,
		createdAt: value.created_at,
		...(typeof value.started_at === "number" && Number.isFinite(value.started_at) ? { startedAt: value.started_at } : {}),
		...(typeof value.completed_at === "number" && Number.isFinite(value.completed_at)
			? { completedAt: value.completed_at }
			: {}),
		...(typeof value.exit_code === "number" && Number.isInteger(value.exit_code) ? { exitCode: value.exit_code } : {}),
		...(typeof value.child_pid === "number" && Number.isInteger(value.child_pid) && value.child_pid > 0
			? { pid: value.child_pid }
			: {}),
		taskDir,
		stdoutPath,
		stderrPath,
	};
}

export class BackgroundTaskTracker {
	private readonly jobs = new Map<string, BackgroundTaskRecord>();
	private readonly refById = new Map<string, string>();
	private readonly idByRef = new Map<string, string>();

	get runningCount(): number {
		return [...this.jobs.values()].filter((job) => LIVE.has(job.status)).length;
	}

	reset(): void {
		this.jobs.clear();
		this.refById.clear();
		this.idByRef.clear();
	}

	/** Rebuild from the session's receipts directory. Missing dir means no jobs. */
	refresh(directory: string | undefined): SessionProcess[] {
		if (!directory) {
			this.reset();
			return [];
		}
		let entries: string[];
		try {
			entries = fs.readdirSync(directory);
		} catch {
			this.reset();
			return [];
		}
		const seen = new Set<string>();
		for (const name of entries) {
			if (!TASK_ID.test(name)) continue;
			const taskDir = path.join(directory, name);
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(taskDir, "state.json"), "utf8");
			} catch {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			const job = parseTaskState(parsed, taskDir);
			if (!job) continue;
			seen.add(job.id);
			this.jobs.set(job.id, job);
			this.refFor(job.id);
		}
		for (const id of [...this.jobs.keys()]) {
			if (!seen.has(id)) {
				this.forget(id);
			}
		}
		this.prune();
		return this.snapshot();
	}

	knownPids(): Set<number> {
		const pids = new Set<number>();
		for (const job of this.jobs.values()) {
			if (LIVE.has(job.status) && job.pid !== undefined) pids.add(job.pid);
		}
		return pids;
	}

	/**
	 * Absolute log paths for the editor, or undefined when `ref` is not ours.
	 * Stdout is always offered when the file exists; stderr only when it has bytes.
	 */
	logFilesForRef(ref: string): string[] | undefined {
		const id = this.idByRef.get(ref);
		const job = id ? this.jobs.get(id) : undefined;
		if (!job) return undefined;
		const files: string[] = [];
		if (this.readableInside(job, job.stdoutPath)) files.push(job.stdoutPath);
		if (this.readableInside(job, job.stderrPath) && fileSize(job.stderrPath) > 0) files.push(job.stderrPath);
		return files;
	}

	/**
	 * Tail of this task's captured stdout/stderr, or undefined when `ref` is not
	 * one we minted. An empty capture is a note, not an empty box.
	 */
	preview(ref: string, maxLines = 100): ProcessOutputPreview | undefined {
		const id = this.idByRef.get(ref);
		const job = id ? this.jobs.get(id) : undefined;
		if (!job) return undefined;
		const limit = Math.min(Math.max(1, maxLines), MAX_PREVIEW_LINES);
		const stdout = this.tailIfOurs(job, job.stdoutPath, limit);
		const stderr = this.tailIfOurs(job, job.stderrPath, limit);
		const stdoutLines = stdout?.lines ?? [];
		const stderrLines = stderr?.lines ?? [];
		if (stdoutLines.length === 0 && stderrLines.length === 0) {
			return {
				ref,
				lines: [],
				note: "This background task has produced no output yet.",
			};
		}
		if (stderrLines.length === 0) {
			return {
				ref,
				lines: stdoutLines,
				source: job.stdoutPath,
				truncated: stdout?.truncated,
			};
		}
		if (stdoutLines.length === 0) {
			return {
				ref,
				lines: stderrLines,
				source: job.stderrPath,
				truncated: stderr?.truncated,
			};
		}
		const lines = ["== stdout ==", ...stdoutLines, "", "== stderr ==", ...stderrLines];
		return {
			ref,
			lines: lines.length > MAX_PREVIEW_LINES ? lines.slice(-MAX_PREVIEW_LINES) : lines,
			source: `${path.basename(job.stdoutPath)} + ${path.basename(job.stderrPath)}`,
			truncated: stdout?.truncated || stderr?.truncated || lines.length > MAX_PREVIEW_LINES,
		};
	}

	snapshot(): SessionProcess[] {
		return [...this.jobs.values()]
			.sort((a, b) => {
				const aLive = LIVE.has(a.status);
				const bLive = LIVE.has(b.status);
				if (aLive !== bLive) return aLive ? -1 : 1;
				if (aLive) return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt);
				return (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt);
			})
			.map((job) => {
				const joined = job.command.join(" ");
				const running = LIVE.has(job.status);
				const startedMs = toMs(job.startedAt ?? job.createdAt);
				return {
					ref: this.refFor(job.id),
					...(job.pid === undefined ? {} : { pid: job.pid }),
					command: shortCommandLabel(joined),
					fullCommand: job.label && job.label !== joined ? `${job.label}\n${joined}` : joined,
					state: running ? ("running" as const) : ("exited" as const),
					startedMs,
					...(running ? {} : { endedMs: toMs(job.completedAt ?? job.createdAt) }),
					...(running || job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
					hasOutput: true as const,
					source: "task" as const,
				};
			});
	}

	private tailIfOurs(
		job: BackgroundTaskRecord,
		file: string,
		maxLines: number,
	): { lines: string[]; truncated: boolean } | undefined {
		if (!this.readableInside(job, file)) return undefined;
		return tailFile(file, maxLines);
	}

	private readableInside(job: BackgroundTaskRecord, file: string): boolean {
		if (!pathInside(job.taskDir, file)) return false;
		try {
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	}

	private prune(): void {
		const finished = [...this.jobs.values()]
			.filter((job) => TERMINAL.has(job.status))
			.sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
		for (const job of finished.slice(MAX_FINISHED)) this.forget(job.id);
	}

	private forget(id: string): void {
		this.jobs.delete(id);
		const ref = this.refById.get(id);
		if (ref) {
			this.refById.delete(id);
			this.idByRef.delete(ref);
		}
	}

	private refFor(id: string): string {
		let ref = this.refById.get(id);
		if (!ref) {
			ref = randomUUID();
			this.refById.set(id, ref);
			this.idByRef.set(ref, id);
		}
		return ref;
	}
}
