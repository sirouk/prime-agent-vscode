/**
 * Shared JSONL wire limits for the two transports this extension speaks: the
 * prime-agent RPC subprocess (`rpc-client.ts`) and the daemon socket
 * (`daemon-sidecar.ts`).
 *
 * The cap exists for one reason — a peer that never sends a newline must not
 * grow the extension host forever. It is NOT a statement about how large a
 * legitimate record may be, and treating it as one is what made big sessions
 * unopenable: `get_messages` for a 6,479-message transcript is a single 4.6 MiB
 * frame, so a 4 MiB cap tore the connection down and killed the agent process
 * mid-resume, with nothing on screen to say why.
 *
 * 64 MiB keeps the runaway-peer guard while leaving roughly an order of
 * magnitude of headroom over the largest transcript observed. A frame this size
 * is a transient string the host parses once when a session opens.
 */
export const MAX_JSONL_FRAME_BYTES = 64 * 1024 * 1024;

/** Human-readable cap, for the message shown when a peer actually trips it. */
export const MAX_JSONL_FRAME_LABEL = "64 MiB";
