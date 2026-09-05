/**
 * Headless coverage for CLI discovery (src/agent-locator.ts).
 *
 * The bug this guards: a GUI-launched editor inherits the launchd PATH, which
 * never contains npm's global bin, so an installed prime-agent spawns as ENOENT
 * and no amount of retrying helps. Every tier below is one of the places the
 * binary actually lives.
 */
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-locator-"));

let failed = 0;
let total = 0;
function check(name, condition, detail = "") {
	total += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

// Built from source, not dist: a stale bundle must not be able to hide a
// discovery regression.
const bundle = path.join(workdir, "agent-locator.cjs");
await esbuild.build({
	entryPoints: ["src/agent-locator.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: bundle,
	logLevel: "silent",
});
const locator = require(bundle);

function makeExecutable(dir, name, body = "#!/bin/sh\nexit 0\n") {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
	return file;
}

const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL, XDG_DATA_HOME: process.env.XDG_DATA_HOME, NVM_DIR: process.env.NVM_DIR };
function restoreEnv() {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// ---- searchDirs -----------------------------------------------------------

const binDir = path.join(workdir, "bin");
const agentPath = makeExecutable(binDir, "prime-agent");
const emptyDir = path.join(workdir, "empty");
fs.mkdirSync(emptyDir, { recursive: true });

check("searchDirs finds an executable", locator.searchDirs("prime-agent", [emptyDir, binDir]) === agentPath);
check("searchDirs returns undefined when absent", locator.searchDirs("prime-agent", [emptyDir]) === undefined);
check("searchDirs ignores empty PATH entries", locator.searchDirs("prime-agent", ["", binDir]) === agentPath);

fs.writeFileSync(path.join(emptyDir, "not-exec"), "x");
check("searchDirs ignores a non-executable file", locator.searchDirs("not-exec", [emptyDir]) === undefined);

// A directory carrying the command's name is not a launchable command; the old
// accessSync-only probe would have returned it and spawned EACCES.
fs.mkdirSync(path.join(emptyDir, "dir-shaped"), { recursive: true });
check("searchDirs ignores a directory", locator.searchDirs("dir-shaped", [emptyDir]) === undefined);

// ---- tier 1: inherited PATH ----------------------------------------------

process.env.PATH = binDir;
let located = await locator.locateAgent("prime-agent");
check("inherited PATH wins", located.source === "path" && located.command === agentPath, located.detail);
check("inherited PATH needs no env override", located.envPath === undefined);

// ---- configured absolute path --------------------------------------------

located = await locator.locateAgent(agentPath);
check("configured path is used as-is", located.source === "configured-path" && located.command === agentPath);
check(
	"configured path puts its own directory on PATH",
	// npm's global entry is a `#!/usr/bin/env node` shim, so the interpreter
	// beside it has to be reachable or the spawn dies at exec time.
	(located.envPath ?? "").split(path.delimiter)[0] === binDir,
	located.envPath,
);

// ---- tier 2: the login shell ---------------------------------------------

const shellDir = path.join(workdir, "shell");
const loginBin = path.join(workdir, "login-bin");
const loginAgent = makeExecutable(loginBin, "prime-agent");
// Stands in for a real login shell: prints a banner (an interactive profile
// usually does) and then the marked PATH the operator actually has.
const fakeShell = makeExecutable(
	shellDir,
	"fakeshell",
	`#!/bin/sh\necho "Welcome to your shell"\nprintf '__PRIME_AGENT_PATH__%s__PRIME_AGENT_PATH__' "${loginBin}"\n`,
);

process.env.PATH = emptyDir;
process.env.SHELL = fakeShell;
located = await locator.locateAgent("prime-agent");
check("login shell PATH is consulted", located.source === "login-shell" && located.command === loginAgent, located.detail);
check("login shell PATH is handed to the child", located.envPath === loginBin, located.envPath);

// A shell that hangs must not hang the start attempt.
const hangingShell = makeExecutable(shellDir, "hangingshell", "#!/bin/sh\nsleep 30\n");
process.env.SHELL = hangingShell;
const startedAt = Date.now();
const timedOut = await locator.loginShellPath(300);
check("a hanging login shell times out", timedOut === undefined && Date.now() - startedAt < 5_000, `${Date.now() - startedAt}ms`);

// ---- tier 3: well-known install locations --------------------------------

const dataHome = path.join(workdir, "data");
const standaloneBin = path.join(dataHome, "prime-agent-node", "current", "bin");
const standaloneAgent = makeExecutable(standaloneBin, "prime-agent");
process.env.XDG_DATA_HOME = dataHome;
process.env.PATH = emptyDir;
process.env.SHELL = makeExecutable(shellDir, "emptyshell", "#!/bin/sh\nexit 0\n");
located = await locator.locateAgent("prime-agent");
check(
	"the installer's own node prefix is searched",
	located.source === "well-known" && located.command === standaloneAgent,
	located.detail,
);
check(
	"a well-known hit prepends its directory to PATH",
	(located.envPath ?? "").split(path.delimiter)[0] === standaloneBin,
	located.envPath,
);

const nvmDir = path.join(workdir, "nvm");
const nvmNewer = makeExecutable(path.join(nvmDir, "versions", "node", "v22.11.0", "bin"), "prime-agent");
makeExecutable(path.join(nvmDir, "versions", "node", "v9.1.0", "bin"), "prime-agent");
process.env.NVM_DIR = nvmDir;
delete process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = path.join(workdir, "no-such-data");
located = await locator.locateAgent("prime-agent");
check("nvm prefixes are searched, newest first", located.command === nvmNewer, located.command);

// ---- nothing anywhere -----------------------------------------------------

delete process.env.NVM_DIR;
process.env.XDG_DATA_HOME = path.join(workdir, "no-such-data");
located = await locator.locateAgent("prime-agent-does-not-exist");
check("an unresolved command is returned unchanged", located.command === "prime-agent-does-not-exist" && located.source === "unresolved");
check("an unresolved command explains where we looked", /login shell/.test(located.detail), located.detail);

restoreEnv();
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? `\nPASS agent-locator (${total} checks)` : `\n${failed}/${total} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
