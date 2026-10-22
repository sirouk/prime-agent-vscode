/**
 * Where the agent keeps its state, resolved the way the agent resolves it.
 *
 * The agent's state directory is `PRIME_AGENT_CODING_AGENT_DIR` when set (the
 * installer's launcher always exports it), otherwise `~/.prime/agent`; its
 * sessions live in `PRIME_AGENT_SESSION_DIR` when set, otherwise in
 * `<state>/sessions`. Reading any of these from a hard-coded home path means an
 * operator who relocated the state sees an empty history and a delete that
 * "succeeds" on the wrong directory. `PRIME_AGENT_DIR` was never a name the agent
 * reads; it is accepted last only because this extension used to.
 *
 * No vscode dependency.
 */

import * as os from "node:os";
import * as path from "node:path";

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function configured(name: string): string | undefined {
	const raw = process.env[name]?.trim();
	return raw ? path.resolve(expandHome(raw)) : undefined;
}

/** The agent's state root. */
export function agentDir(): string {
	return configured("PRIME_AGENT_CODING_AGENT_DIR") ?? configured("PRIME_AGENT_DIR") ?? path.join(os.homedir(), ".prime", "agent");
}

/** The directory session transcripts live in. */
export function sessionsDir(): string {
	return configured("PRIME_AGENT_SESSION_DIR") ?? path.join(agentDir(), "sessions");
}
