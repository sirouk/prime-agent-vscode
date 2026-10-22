/**
 * createConfigFromArgs: the CLI flags an operator configured, translated into
 * the `config` of a daemon `create`. A flag with no create-time equivalent must
 * be reported, never silently dropped: a setting that looks applied and is not
 * is worse than one that is refused.
 */
import * as os from "node:os";
import * as path from "node:path";
import { bundle } from "./bundle.mjs";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const { mod, dispose } = bundle("src/session-config.ts");
const { createConfigFromArgs } = mod;
const root = "/work/space";

let r = createConfigFromArgs([], root);
check("no args: just the workspace and the execution mode", r.config.cwd === root && r.config.executionMode === "rpc" && r.unsupported.length === 0, JSON.stringify(r.config));

r = createConfigFromArgs(["--provider", "chutes", "--model", "chutes/zai-org/GLM-5.2-TEE", "--thinking", "low"], root);
check("provider, model and thinking map straight across", r.config.provider === "chutes" && r.config.model === "chutes/zai-org/GLM-5.2-TEE" && r.config.thinking === "low", JSON.stringify(r.config));

r = createConfigFromArgs(["--model", "a/one", "--model", "b/two"], root);
check("a repeated --model: the last one wins, as on the CLI", r.config.model === "b/two");

r = createConfigFromArgs(["--system-prompt", "Be terse.", "--append-system-prompt", "One.", "--append-system-prompt", "Two."], root);
check("--system-prompt replaces, --append-system-prompt accumulates", r.config.systemPrompt === "Be terse." && JSON.stringify(r.config.appendSystemPrompt) === JSON.stringify(["One.", "Two."]), JSON.stringify(r.config));

r = createConfigFromArgs(["--skill", "skills/a", "--skill", "~/skills/b", "--prompt-template", "t.md"], root);
check("skills and templates resolve against the workspace, ~ against home", JSON.stringify(r.config.skills) === JSON.stringify([path.resolve(root, "skills/a"), path.join(os.homedir(), "skills/b")]) && JSON.stringify(r.config.promptTemplates) === JSON.stringify([path.resolve(root, "t.md")]), JSON.stringify(r.config));

r = createConfigFromArgs(["--session-dir", "sessions", "--cwd", "/elsewhere"], root);
check("--session-dir and --cwd are honoured", r.config.sessionDir === path.resolve(root, "sessions") && r.config.cwd === "/elsewhere", JSON.stringify(r.config));

{
	const fs = await import("node:fs");
	const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-canon-")));
	const link = `${real}-link`;
	fs.symlinkSync(real, link);
	r = createConfigFromArgs(["--session-dir", path.join(link, "not", "yet", "created")], root);
	check("a --session-dir through a symlink is canonicalised, existing or not", r.config.sessionDir === path.join(real, "not", "yet", "created"), String(r.config.sessionDir));
	fs.rmSync(link, { force: true });
	fs.rmSync(real, { recursive: true, force: true });
}

r = createConfigFromArgs(["--model=chutes/x", "--daemon-socket=/tmp/d.sock"], root);
check("--flag=value spells the same as --flag value", r.config.model === "chutes/x" && r.daemonSocket === "/tmp/d.sock", JSON.stringify([r.config.model, r.daemonSocket]));

r = createConfigFromArgs(["--daemon-socket", "~/d.sock", "--model", "m/x"], root);
check("--daemon-socket selects the endpoint, not the session", r.daemonSocket === path.join(os.homedir(), "d.sock") && !("daemonSocket" in r.config) && r.unsupported.length === 0);

r = createConfigFromArgs(["--api-key", "sk-secret", "--autonomous", "--goal", "ship it", "--no-session", "--resume", "abc"], root);
check("flags with no create equivalent are reported, not dropped", JSON.stringify(r.unsupported) === JSON.stringify(["--api-key <redacted>", "--autonomous", "--goal ship it", "--no-session", "--resume abc"]), JSON.stringify(r.unsupported));
r = createConfigFromArgs(["--resume", "--provider", "anthropic"], root);
check("a bare --resume does not swallow the flag after it", r.config.provider === "anthropic" && JSON.stringify(r.unsupported) === JSON.stringify(["--resume"]), JSON.stringify(r));
check("an API key never reaches the persisted create config, nor the report", !JSON.stringify(r.config).includes("sk-secret") && !JSON.stringify(r.unsupported).includes("sk-secret"));

r = createConfigFromArgs(["--verbose", "--no-themes", "--model", "m/x"], root);
check("flags that change nothing for a session are neither applied nor reported", r.unsupported.length === 0 && r.config.model === "m/x");

r = createConfigFromArgs(["--model"], root);
check("a value flag with no value is reported", JSON.stringify(r.unsupported) === JSON.stringify(["--model"]) && r.config.model === undefined);

dispose();
console.log(failed === 0 ? "\nPASS session-config" : `\n${failed} session-config checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
