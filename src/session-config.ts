/**
 * Turn the CLI arguments an operator configured (`primeAgent.args`,
 * `primeAgent.model`) into the `config` of a daemon `create`.
 *
 * A subprocess takes flags; a daemon session takes a config object. The
 * Rust CLI performs the same translation for its own daemon-backed modes
 * (`daemon_acp_create` in pa-cli), and so does this: the flags that describe the
 * session map onto the same keys, and anything that cannot be expressed on a
 * create is reported rather than silently dropped — a flag that has no effect is
 * a configuration that looks applied and is not.
 *
 * No vscode dependency: exercised headless by test/session-config.test.mjs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CreateConfig {
	/** The `config` object for a daemon `create`. */
	config: Record<string, unknown>;
	/**
	 * `--daemon-socket`: not part of a session, but of where the service is. The
	 * flag selects the endpoint exactly as it does for the CLI.
	 */
	daemonSocket?: string;
	/** Arguments that have no equivalent on a daemon create, verbatim. */
	unsupported: string[];
}

/** Flags whose value is the next argument. */
const VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--thinking",
	"--system-prompt",
	"--append-system-prompt",
	"--skill",
	"--prompt-template",
	"--session-dir",
	"--cwd",
	"--daemon-socket",
	"--api-key",
	"--models",
	"--theme",
	"--goal",
	"--goal-token-budget",
	"--fork",
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
]);

/** Flags whose value is optional: a bare `--resume` opens the CLI's own picker. */
const OPTIONAL_VALUE_FLAGS = new Set(["--resume", "-r"]);

/** Flags that change nothing a daemon session cares about. */
const IGNORED_FLAGS = new Set(["--verbose", "--no-themes"]);

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/**
 * The real path, even for a directory that does not exist yet (its nearest existing
 * ancestor is resolved and the rest appended).
 *
 * A session file created under a symlinked sessions directory is never persisted:
 * the daemon's session lease compares the canonical path with the one it was handed
 * and refuses every append ("session lease does not own append target"), so the
 * transcript silently stays empty while the live stream looks fine. On macOS
 * `/tmp` and `/var` are symlinks, so any `--session-dir` there hits it.
 */
function canonicalPath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		const parent = path.dirname(target);
		return parent === target ? target : path.join(canonicalPath(parent), path.basename(target));
	}
}

export function createConfigFromArgs(args: readonly string[], workspaceRoot: string): CreateConfig {
	const config: Record<string, unknown> = { cwd: workspaceRoot, executionMode: "rpc" };
	const unsupported: string[] = [];
	let daemonSocket: string | undefined;
	const appendSystemPrompt: string[] = [];
	const skills: string[] = [];
	const promptTemplates: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		// `--flag=value` is accepted by the CLI; split it so both spellings behave alike.
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals > 0 ? arg.slice(0, equals) : arg;
		const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
		if (IGNORED_FLAGS.has(flag)) continue;
		const optionalValue = OPTIONAL_VALUE_FLAGS.has(flag);
		if (!VALUE_FLAGS.has(flag) && !optionalValue) {
			unsupported.push(arg);
			continue;
		}
		let value = inline;
		if (value === undefined) {
			value = args[index + 1];
			// An optional value never swallows the flag that follows it.
			if (value === undefined || (optionalValue && value.startsWith("-"))) {
				unsupported.push(arg);
				continue;
			}
			index += 1;
		}
		switch (flag) {
			case "--provider":
				config.provider = value;
				break;
			case "--model":
				config.model = value;
				break;
			case "--thinking":
				config.thinking = value;
				break;
			case "--system-prompt":
				config.systemPrompt = value;
				break;
			case "--append-system-prompt":
				appendSystemPrompt.push(value);
				break;
			case "--skill":
				skills.push(path.resolve(workspaceRoot, expandHome(value)));
				break;
			case "--prompt-template":
				promptTemplates.push(path.resolve(workspaceRoot, expandHome(value)));
				break;
			case "--session-dir":
				config.sessionDir = canonicalPath(path.resolve(workspaceRoot, expandHome(value)));
				break;
			case "--cwd":
				config.cwd = path.resolve(workspaceRoot, expandHome(value));
				break;
			case "--daemon-socket":
				daemonSocket = expandHome(value);
				break;
			default:
				// Valid agent flags with no create-time equivalent (--api-key is
				// deliberately one: a create config is persisted).
				// Reported to the output log and a notice, so a secret is named, not echoed.
				unsupported.push(flag === "--api-key" ? `${flag} <redacted>` : inline === undefined ? `${flag} ${value}` : arg);
		}
	}

	if (appendSystemPrompt.length > 0) config.appendSystemPrompt = appendSystemPrompt;
	if (skills.length > 0) config.skills = skills;
	if (promptTemplates.length > 0) config.promptTemplates = promptTemplates;
	return { config, unsupported, ...(daemonSocket ? { daemonSocket } : {}) };
}
