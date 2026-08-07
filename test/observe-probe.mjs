import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

// test/observe-probe.ts
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

// test/observe-probe.ts
var targetId = process.argv[2];
if (!targetId) {
  console.error("usage: node test/observe-probe.mjs <session-id>");
  process.exit(1);
}
var workdir = fs2.mkdtempSync(path.join(os.tmpdir(), "observe-probe-"));
var client = new RpcClient({ command: "prime-agent", cwd: workdir, args: ["--session-dir", path.join(workdir, "s")] });
client.start();
await new Promise((r) => setTimeout(r, 400));
var res = await client.request({ type: "observe", activeSessionId: targetId }, 3e4);
console.log("OBSERVE RESPONSE:", JSON.stringify({ success: res.success, error: res.error, messageCount: (res.data && Array.isArray(res.data.messages) ? res.data.messages.length : void 0) === void 0 ? void 0 : res.data.messages.length }).slice(0, 400));
client.stop();
fs2.rmSync(workdir, { recursive: true, force: true });
