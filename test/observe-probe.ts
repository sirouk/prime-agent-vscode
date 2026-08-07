/**
 * Probe: can an RPC client `observe` a resident session by its session id
 * (the jsonl filename stem)? Response tells us read-only attach feasibility.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../src/rpc-client.ts";

const targetId = process.argv[2];
if (!targetId) {
	console.error("usage: node test/observe-probe.mjs <session-id>");
	process.exit(1);
}
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "observe-probe-"));
const client = new RpcClient({ command: "prime-agent", cwd: workdir, args: ["--session-dir", path.join(workdir, "s")] });
client.start();
await new Promise((r) => setTimeout(r, 400));

const res = await client.request({ type: "observe", activeSessionId: targetId }, 30_000);
console.log("OBSERVE RESPONSE:", JSON.stringify({ success: res.success, error: res.error, messageCount: (res.data && Array.isArray(res.data.messages) ? res.data.messages.length : undefined) === undefined ? undefined : res.data.messages.length }).slice(0, 400));
client.stop();
fs.rmSync(workdir, { recursive: true, force: true });
