/**
 * What the session controller needs from whatever carries its agent session:
 * a request/response channel plus the agent's event stream.
 *
 * Two transports satisfy it. `RpcClient` speaks to a `prime-agent --mode rpc`
 * subprocess; `DaemonRpcClient` hosts the session on the background service.
 * They differ in lifecycle (a process versus a daemon-owned worker) and in what
 * the agent can do inside the session, not in this surface — which is why the
 * controller, the history and the strip above it never learn which one it has.
 *
 * Events: `event` (an agent event), `exit` (the session is over), and, for
 * transports that can fall behind the live stream, `resync` (repaint from a
 * fresh snapshot). `RpcClient` additionally emits `message`, `extensionUiRequest`,
 * `stderr`, `spawnError` and `protocolError`.
 */

import type { EventEmitter } from "node:events";
import type { RpcReply } from "./rpc-client.js";

export interface AgentClient extends EventEmitter {
	readonly running: boolean;
	request(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcReply>;
	sendRaw(message: Record<string, unknown>): void;
	start(): void;
	/**
	 * Stop the session. A transport that must tell a remote service returns a promise
	 * that settles once it has, so a window closing can wait for it.
	 */
	stop(): void | Promise<void>;
}
