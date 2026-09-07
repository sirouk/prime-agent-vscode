/**
 * Prime Agent extension: background jobs the agent can start, watch, read and stop.
 *
 * Why this exists, in one paragraph. Prime Agent's `bash()` returns a handle
 * whose output lives in a buffer inside the IPython kernel, and nothing is
 * notified when the command ends: `_report`/`_watch` set the handle's own state
 * and the only completion callback wakes a coroutine that is already awaiting.
 * So an agent that starts a long command and then ends its turn has thrown the
 * job over a wall — it cannot learn the exit code, cannot read the output, and
 * no client can stop it. Every symptom of that (a session that looks idle while
 * real work runs; a twelve-minute job whose result nobody ever sees) comes from
 * the same missing piece: nobody owns the process.
 *
 * Here the agent process owns it. That single change is what makes the rest
 * possible, and each capability below is a direct consequence:
 *
 * - the exit code is delivered by the OS, so a job can be reported truthfully;
 * - output goes straight to a file descriptor, so it survives this process and
 *   is readable by a UI that cannot call into it;
 * - the job is a process group we created, so stopping it is a signal, not a
 *   guess;
 * - and `pi.sendMessage(..., { triggerTurn: true })` hands the finished job back
 *   to an idle agent, which is the thing that could not happen before.
 *
 * Install: copy this directory to `~/.prime/agent/extensions/background-jobs/`,
 * or run `prime-agent -e <path-to-this-directory>`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { JobManager, type JobRecord } from "./jobs.js";

/**
 * The `customType` every client keys on. The VS Code extension's Processes panel
 * reads job records out of messages carrying this type, so it is a wire contract
 * with another codebase: change it and the panel goes blind.
 */
const JOB_TYPE = "background-job";

function describe(record: JobRecord): string {
	const seconds = Math.max(0, Math.round(((record.endedMs ?? Date.now()) - record.startedMs) / 1000));
	const how =
		record.signal !== undefined
			? `stopped by ${record.signal}`
			: record.exitCode === 0
				? "exit 0"
				: `exit ${record.exitCode ?? "unknown"}`;
	return `Background job ${record.id} finished after ${seconds}s (${how}): ${record.command}`;
}

export default function backgroundJobs(pi: ExtensionAPI): void {
	const jobs = new JobManager();

	// The wake. `triggerTurn` starts a turn when the agent is idle, which is
	// exactly the state a long job leaves it in; "followUp" means a job that ends
	// mid-turn waits for the current work to finish instead of cutting into it.
	// `details` carries the structured record for UIs; `content` is what the model
	// reads. Both come from the same object so they can never disagree.
	jobs.onExit((record) => {
		try {
			pi.sendMessage(
				{ customType: JOB_TYPE, content: describe(record), display: true, details: { job: record } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// A session that is already tearing down cannot take a message. The job
			// still ended cleanly and its log is still on disk.
		}
	});

	// A job started here belongs to this agent. Leaving one running past the
	// session would recreate the orphan this extension exists to prevent.
	pi.on("session_shutdown", async () => {
		jobs.killAll();
	});

	pi.registerTool({
		name: "background",
		label: "Background job",
		description:
			"Run a shell command as a background job that outlives the current turn. Returns immediately with a job id. " +
			"Use action 'start' to launch, 'list' to see jobs and their exit codes, 'output' to read a job's output, " +
			"and 'kill' to stop one. When a job finishes you are told automatically, so do not poll it in a loop.",
		promptGuidelines: [
			"Use the background tool for any command expected to outlive the turn (builds, long test runs, indexing, data jobs) instead of bash(), so it can be read and stopped after the turn ends.",
			"Do not poll the background tool in a loop: a finished job is delivered to you automatically with its exit code.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("start"), Type.Literal("list"), Type.Literal("output"), Type.Literal("kill")],
				{ description: "What to do" },
			),
			command: Type.Optional(Type.String({ description: "Shell command to run (action 'start')" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (action 'start'); defaults to the session cwd" })),
			id: Type.Optional(Type.String({ description: "Job id (actions 'output' and 'kill')" })),
			lines: Type.Optional(Type.Number({ description: "How many trailing lines to read (action 'output'); default 100" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (value: string, details: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text: value }],
				details,
			});
			switch (params.action) {
				case "start": {
					if (!params.command?.trim()) return text("background: 'start' needs a command.", { error: "missing command" });
					const record = jobs.start({ command: params.command, cwd: params.cwd || ctx.cwd });
					return text(
						`Started background job ${record.id} (pid ${record.pid ?? "?"}). Output: ${record.logPath}\n` +
							"You will be told when it finishes; do not poll it.",
						{ job: record },
					);
				}
				case "list": {
					const all = jobs.list();
					if (all.length === 0) return text("No background jobs.", { jobs: [] });
					const rows = all.map((job) =>
						job.state === "running"
							? `${job.id}  running  ${job.command}`
							: `${job.id}  ${job.signal ? `killed(${job.signal})` : `exit ${job.exitCode ?? "?"}`}  ${job.command}`,
					);
					return text(rows.join("\n"), { jobs: all });
				}
				case "output": {
					if (!params.id) return text("background: 'output' needs a job id.", { error: "missing id" });
					const record = jobs.get(params.id);
					const tail = jobs.output(params.id, params.lines ?? 100);
					if (!record) return text(`background: no job ${params.id}.`, { error: "unknown job" });
					if (!tail) return text(`Job ${params.id} has no readable output yet (${record.logPath}).`, { job: record });
					return text(
						tail.lines.length > 0 ? tail.lines.join("\n") : `Job ${params.id} has produced no output yet.`,
						{ job: record, truncated: tail.truncated },
					);
				}
				case "kill": {
					if (!params.id) return text("background: 'kill' needs a job id.", { error: "missing id" });
					const stopped = jobs.kill(params.id);
					const record = jobs.get(params.id);
					return text(
						stopped ? `Stopping job ${params.id}.` : `background: job ${params.id} is not running.`,
						record ? { job: record } : {},
					);
				}
			}
		},
	});

	// The human-facing surface. Also the path a UI uses to stop a job: Prime Agent
	// checks extension commands before anything else, so `/jobs kill <id>` runs
	// this handler and never reaches the model.
	pi.registerCommand("jobs", {
		description:
			"Background jobs: /jobs [list | start <command> | output <id> | kill <id>]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [verb = "list", id] = trimmed.split(/\s+/).filter(Boolean);
			if (verb === "start") {
				// Everything after the verb is the command, verbatim: splitting it into
				// words would quietly mangle quoting and redirection.
				const command = trimmed.slice(trimmed.indexOf("start") + "start".length).trim();
				if (!command) {
					ctx.ui.notify("Usage: /jobs start <command>", "info");
					return;
				}
				const record = jobs.start({ command, cwd: ctx.cwd });
				ctx.ui.notify(`Started background job ${record.id} (pid ${record.pid ?? "?"}). Output: ${record.logPath}`, "info");
				return;
			}
			if (verb === "kill" && id) {
				ctx.ui.notify(jobs.kill(id) ? `Stopping background job ${id}.` : `No running job ${id}.`, "info");
				return;
			}
			if (verb === "output" && id) {
				const tail = jobs.output(id, 100);
				ctx.ui.notify(tail ? tail.lines.join("\n") || `Job ${id} has produced no output.` : `No job ${id}.`, "info");
				return;
			}
			const all = jobs.list();
			ctx.ui.notify(
				all.length === 0
					? "No background jobs."
					: all
							.map((job) =>
								job.state === "running"
									? `${job.id}  running  ${job.command}`
									: `${job.id}  ${job.signal ? `killed(${job.signal})` : `exit ${job.exitCode ?? "?"}`}  ${job.command}`,
							)
							.join("\n"),
				"info",
			);
		},
	});
}
