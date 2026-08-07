import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

// test/smoke.ts
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// src/rpc-client.ts
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter } from "node:path";
import * as fs from "node:fs";
var RpcClient = class extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
  }
  process = null;
  pending = /* @__PURE__ */ new Map();
  nextId = 0;
  buffer = "";
  _stderr = "";
  get stderrText() {
    return this._stderr;
  }
  get running() {
    return this.process !== null;
  }
  start() {
    if (this.process) return;
    const command = this.resolveCommand(this.options.command ?? "prime-agent");
    const args = ["--mode", "rpc", ...this.options.args ?? []];
    this._stderr = "";
    this.process = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk) => this.onStdout(chunk));
    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk) => {
      this._stderr += chunk;
      if (this._stderr.length > 64e3) {
        this._stderr = this._stderr.slice(-32e3);
      }
      this.emit("stderr", chunk);
    });
    this.process.on("error", (err) => {
      this.failAll(err);
      this.emit("spawnError", err);
    });
    this.process.on("exit", (code, signal) => {
      this.process = null;
      this.failAll(new Error(`prime-agent exited (code ${code ?? "?"}, signal ${signal ?? "none"})`));
      this.emit("exit", code, signal);
    });
  }
  /** Resolve a bare command name to an absolute path where possible so spawn errors are clearer. */
  resolveCommand(command) {
    if (command.includes("/") || command.includes("\\")) {
      return command;
    }
    const pathEnv = process.env.PATH ?? "";
    const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
    for (const dir of pathEnv.split(delimiter)) {
      for (const ext of extensions) {
        const candidate = `${dir}/${command}${ext}`;
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
        }
      }
    }
    return command;
  }
  onStdout(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length > 0) {
        this.handleLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }
  handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit("protocolError", line);
      return;
    }
    this.options.onWire?.(
      `<- ${String(parsed.type)}${parsed.type === "response" ? `/${String(parsed.command)} success=${String(parsed.success)}` : ""}`
    );
    if (parsed.type === "response") {
      const id = parsed.id;
      if (id) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve({
            command: parsed.command,
            success: parsed.success === true,
            data: parsed.data,
            error: typeof parsed.error === "string" ? parsed.error : void 0
          });
          return;
        }
      }
      this.emit("response", parsed);
      return;
    }
    this.emit("message", parsed);
    if (parsed.type === "extension_ui_request") {
      this.emit("extensionUiRequest", parsed);
    } else {
      this.emit("event", parsed);
    }
  }
  /** Send a command and await its response. Use sendRaw() for extension_ui_response (no response follows). */
  request(command, timeoutMs = 12e4) {
    if (!this.process) {
      return Promise.reject(new Error("Agent process is not running"));
    }
    const id = `req-${++this.nextId}`;
    const body = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${command.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify(body));
    });
  }
  /** Fire-and-forget message (used for extension_ui_response and abort). */
  sendRaw(message) {
    if (!this.process) return;
    this.writeLine(JSON.stringify(message));
  }
  writeLine(line) {
    try {
      this.options.onWire?.(`-> ${line.slice(0, 140)}`);
      this.process?.stdin?.write(`${line}
`);
    } catch (err) {
      this.emit("protocolError", err);
    }
  }
  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  stop() {
    if (!this.process) return;
    const proc = this.process;
    this.process = null;
    try {
      proc.kill("SIGTERM");
    } catch {
    }
    const killer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
      }
    }, 1500);
    killer.unref?.();
    this.failAll(new Error("Agent process stopped"));
  }
};

// test/smoke.ts
var results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: condition, detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  \u2014 ${detail}` : ""}`);
}
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
var workdir = fs2.mkdtempSync(path.join(os.tmpdir(), "prime-agent-vs-ext-smoke-"));
var sessionDir = path.join(workdir, "sessions");
var client = new RpcClient({
  command: process.env.PRIME_AGENT_COMMAND ?? "prime-agent",
  cwd: workdir,
  args: ["--session-dir", sessionDir]
});
var events = [];
var seenTypes = /* @__PURE__ */ new Set();
client.on("event", (event) => {
  events.push(event);
  if (event?.type) seenTypes.add(event.type);
});
client.on("stderr", () => {
});
client.on("protocolError", (line) => {
  console.error("PROTOCOL ERROR:", String(line).slice(0, 200));
});
var failed = false;
try {
  client.start();
  await new Promise((r) => setTimeout(r, 400));
  check("process starts", client.running, workdir);
  const state = await client.request({ type: "get_state" }, 3e4);
  check("get_state succeeds", state.success);
  const modelLabel = state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : "none";
  console.log(`  model: ${modelLabel}  thinking: ${state.data?.thinkingLevel}`);
  const commandsRes = await client.request({ type: "get_commands" }, 3e4);
  check("get_commands succeeds", commandsRes.success);
  console.log(`  commands available: ${commandsRes.data?.commands?.length ?? 0}`);
  const modelsRes = await client.request({ type: "get_available_models" }, 6e4);
  check("get_available_models succeeds", modelsRes.success);
  console.log(`  models available: ${modelsRes.data?.models?.length ?? 0}`);
  const bashRes = await client.request({ type: "bash", command: "echo hello-from-smoke" }, 3e4);
  check("bash command succeeds", bashRes.success && String(bashRes.data?.output ?? "").includes("hello-from-smoke"));
  const [s1, s2] = await Promise.all([client.request({ type: "get_state" }, 3e4), client.request({ type: "get_session_stats" }, 3e4)]);
  check("parallel requests correlate by id", s1.success && s2.success);
  const promptRes = await client.request({ type: "prompt", message: "Reply with exactly: PONG. Do not use any tools." }, 6e4);
  check("prompt accepted", promptRes.success, promptRes.error ?? "");
  await waitFor(() => events.find((e) => e.type === "agent_end"), 18e4, "agent_end");
  check("agent_start seen", seenTypes.has("agent_start"));
  check("message_start seen", seenTypes.has("message_start"));
  check("message_update seen", seenTypes.has("message_update"));
  check("message_end seen", seenTypes.has("message_end"));
  check("agent_end seen", seenTypes.has("agent_end"));
  const lastText = await client.request({ type: "get_last_assistant_text" }, 3e4);
  check(
    "assistant replied PONG",
    lastText.success && /pong/i.test(lastText.data?.text ?? ""),
    String(lastText.data?.text ?? "").slice(0, 60)
  );
  const stats = await client.request({ type: "get_session_stats" }, 3e4);
  check("get_session_stats succeeds", stats.success && stats.data?.tokens?.total > 0, JSON.stringify(stats.data?.tokens ?? {}));
  const ns = await client.request({ type: "new_session" }, 3e4);
  check("new_session succeeds", ns.success);
  const messages = await client.request({ type: "get_messages" }, 3e4);
  check("messages cleared after new_session", messages.success && (messages.data?.messages?.length ?? 0) === 0);
  client.stop();
  await new Promise((r) => setTimeout(r, 300));
  check("process stops", !client.running);
  const client2 = new RpcClient({ command: process.env.PRIME_AGENT_COMMAND ?? "prime-agent", cwd: workdir, args: ["--session-dir", sessionDir] });
  client2.start();
  await new Promise((r) => setTimeout(r, 300));
  const s3 = await client2.request({ type: "get_state" }, 3e4);
  check("restart works", s3.success);
  client2.stop();
} catch (err) {
  failed = true;
  console.error("SMOKE ERROR:", err);
} finally {
  client.stop();
  fs2.rmSync(workdir, { recursive: true, force: true });
}
var failures = results.filter((r) => !r.ok).length;
console.log(`
${results.length - failures}/${results.length} checks passed${failed ? " (aborted early)" : ""}`);
process.exit(failures > 0 || failed ? 1 : 0);
//# sourceMappingURL=smoke.mjs.map
