/**
 * Finds the Prime Agent CLI for a GUI-launched editor.
 *
 * The installer is `npm install -g`, so the binary lands in npm's global bin —
 * a Homebrew prefix, an nvm version directory, or the installer's own
 * `~/.local/share/prime-agent-node/current/bin` — and the PATH entry for it is
 * written into a shell profile. An editor launched from the Dock or Finder gets
 * the launchd PATH (`/etc/paths`: /usr/local/bin, /usr/bin, /bin, /usr/sbin,
 * /sbin) instead, which contains none of those, so a perfectly good install
 * spawns as ENOENT.
 *
 * `process.env.PATH` is also fixed when the extension host starts, so an
 * operator who installs the CLI while the window is open cannot fix it by
 * retrying — hence a fresh lookup on every start attempt rather than a cached
 * one, and a login-shell probe that reads the PATH the operator actually has.
 *
 * No vscode dependency: the search is exercised headless by
 * test/agent-locator.test.mjs.
 */

import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export interface LocatedAgent {
	/** What to spawn: an absolute path when one was found, else the name unchanged. */
	command: string;
	/** PATH to hand the child when the inherited one would not find it (or its node). */
	envPath?: string;
	/** Where it came from. Output-channel diagnostics only. */
	source: "path" | "login-shell" | "well-known" | "configured-path" | "unresolved";
	/** One line for the output channel, always populated. */
	detail: string;
}

/** Login-shell probe budget. Only ever paid on the failure path. */
const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const PROBE_MARKER = "__PRIME_AGENT_PATH__";

function executableNames(command: string): string[] {
	return process.platform === "win32"
		? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
		: [command];
}

function isExecutableFile(candidate: string): boolean {
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** First executable named `command` across `dirs`, or undefined. */
export function searchDirs(command: string, dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of executableNames(command)) {
			const candidate = join(dir, name);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

export function splitPath(pathEnv: string | undefined): string[] {
	return (pathEnv ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

/** The global prefix from ~/.npmrc, for operators who relocated npm's bin. */
function npmrcPrefix(home: string): string | undefined {
	try {
		const text = fs.readFileSync(join(home, ".npmrc"), "utf8");
		const match = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(text);
		if (!match) return undefined;
		const value = match[1].replace(/^["']|["']$/g, "");
		return value.startsWith("~") ? join(home, value.slice(1)) : value;
	} catch {
		return undefined;
	}
}

/** nvm keeps one bin directory per installed node; newest first. */
function nvmBinDirs(home: string): string[] {
	const root = join(process.env.NVM_DIR || join(home, ".nvm"), "versions", "node");
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	return entries
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
		.map((version) => join(root, version, "bin"));
}

/**
 * Where the documented install paths put the binary. Consulted only when the
 * inherited PATH and the login shell both came up empty, so a guess here costs
 * nothing that was going to work anyway.
 */
export function wellKnownDirs(home = os.homedir()): string[] {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		return appData ? [join(appData, "npm")] : [];
	}
	const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
	const dirs = [
		// The installer's own bootstrapped node, whose PATH export it appends to
		// ~/.zshrc — a file only interactive shells read.
		join(dataHome, "prime-agent-node", "current", "bin"),
		...nvmBinDirs(home),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".local", "bin"),
	];
	const prefix = npmrcPrefix(home);
	if (prefix) dirs.splice(1, 0, join(prefix, "bin"));
	return dirs;
}

/**
 * The PATH the operator actually has, read from their login shell.
 *
 * `-i` is required, not decoration: the installer writes its PATH export to
 * ~/.zshrc, which a non-interactive shell never reads. The inner `/bin/sh`
 * exists so $PATH is printed as the colon-joined environment string — in fish
 * it is a list, and "$PATH" there would come back space-separated.
 */
export function loginShellPath(timeoutMs = LOGIN_SHELL_TIMEOUT_MS): Promise<string | undefined> {
	const shell = process.env.SHELL;
	if (process.platform === "win32" || !shell || !isExecutableFile(shell)) {
		return Promise.resolve(undefined);
	}
	const probe = `/bin/sh -c 'printf "${PROBE_MARKER}%s${PROBE_MARKER}" "$PATH"'`;
	return new Promise((resolve) => {
		const env = { ...process.env };
		// Same reason as the agent spawn: this flag turns an Electron binary into
		// node, and a profile that starts one would misbehave under it.
		delete env.ELECTRON_RUN_AS_NODE;
		let child;
		try {
			child = spawn(shell, ["-ilc", probe], {
				env,
				// A profile that reads stdin (a prompt, an agent unlock) must hit EOF
				// rather than hang out the whole timeout.
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			resolve(undefined);
			return;
		}
		let out = "";
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			// An interactive profile can print a banner; the markers are what make
			// the PATH findable inside that noise. Cap the buffer so a chatty rc
			// cannot grow it without bound.
			out = (out + chunk).slice(-256_000);
		});
		child.on("error", () => finish(undefined));
		child.on("close", () => {
			const match = new RegExp(`${PROBE_MARKER}([^\\n]*?)${PROBE_MARKER}`).exec(out);
			finish(match?.[1] || undefined);
		});
	});
}

/**
 * Resolve `command` to something spawnable, plus the PATH its child needs.
 *
 * The PATH matters as much as the binary: npm's global entry is a shim with a
 * `#!/usr/bin/env node` shebang, so finding prime-agent under an nvm or
 * bootstrapped-node prefix that the editor cannot see would still fail at exec
 * time with no node on PATH.
 */
export async function locateAgent(command: string, log?: (line: string) => void): Promise<LocatedAgent> {
	const note = (line: string): void => log?.(`[prime-agent] locate: ${line}`);
	const withDir = (resolved: string): string =>
		[dirname(resolved), ...splitPath(process.env.PATH)].join(delimiter);

	if (command.includes("/") || command.includes("\\")) {
		// A configured absolute path still needs its own directory on PATH so the
		// interpreter beside it is reachable.
		return {
			command,
			envPath: withDir(command),
			source: "configured-path",
			detail: `using configured path ${command}`,
		};
	}

	const onPath = searchDirs(command, splitPath(process.env.PATH));
	if (onPath) return { command: onPath, source: "path", detail: `found on inherited PATH: ${onPath}` };

	note(`"${command}" is not on the inherited PATH; asking the login shell`);
	const shellPath = await loginShellPath();
	if (shellPath) {
		const found = searchDirs(command, splitPath(shellPath));
		if (found) {
			return {
				command: found,
				// The whole login PATH, not just this directory: the agent shells out
				// to the operator's own toolchain and should see what they see.
				envPath: shellPath,
				source: "login-shell",
				detail: `found via login shell: ${found}`,
			};
		}
		note("login shell PATH did not contain it either");
	} else {
		note("login shell PATH was unavailable");
	}

	const dirs = wellKnownDirs();
	const wellKnown = searchDirs(command, dirs);
	if (wellKnown) {
		return {
			command: wellKnown,
			envPath: withDir(wellKnown),
			source: "well-known",
			detail: `found in a known install location: ${wellKnown}`,
		};
	}

	note(`no match in ${dirs.join(", ")}`);
	return {
		command,
		source: "unresolved",
		detail: "not on PATH, not in your login shell's PATH, and not in the usual npm install locations",
	};
}
