/**
 * Prime Agent RPC protocol types.
 *
 * Mirrors packages/coding-agent/src/modes/rpc/rpc-types.ts, duplicated here so the
 * extension has zero runtime dependencies on the coding-agent package. Keep shapes
 * additive-tolerant: unknown fields are ignored at runtime.
 */

// ---------------------------------------------------------------------------
// AI message content (subset of @earendil-works/pi-ai types)
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	// The agent sends the full per-category breakdown (ai/src/types.ts Usage);
	// narrowing it to `total` hid the per-turn input price the user footer needs.
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number };
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextContent | ImageContent>;
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextContent | ThinkingContent | ToolCallContent>;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
	timestamp?: number;
}

/**
 * One file edit as prime-agent publishes it (core/kernel KernelDiffDisplay).
 * The bundled `edit` skill emits these over `display_data`; the ipython tool
 * forwards them on its result details. This is the ONLY structured change
 * record the agent exposes — nothing else may be presented as a diff.
 */
export interface ToolDiffDetail {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` began in the file. */
	startLine?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
	timestamp?: number;
	/** Tool-specific payload; ipython carries `diffs` for every edit-skill call. */
	details?: { diffs?: ToolDiffDetail[]; [key: string]: unknown };
}

/** Messages can be extension-defined; only the known roles are rendered. */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | { role: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Agent events (subset of @earendil-works/pi-agent-core AgentEvent)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: string; [key: string]: unknown };

export interface SessionActionSnapshot {
	queuedCount?: number;
	steering?: Array<{ text?: string }>;
	followUps?: Array<{ text?: string }>;
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	// Session-level lifecycle events forwarded by RPC mode
	| { type: "compaction_start"; reason: string; customInstructions?: string }
	| { type: "compaction_end"; reason: string; aborted?: boolean; errorMessage?: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| { type: "thinking_level_changed"; level: string }
	| { type: "session_info_changed"; name?: string };

export interface RpcModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	reasoning?: boolean;
	/** Input modalities, e.g. ["text"] or ["text","image"] (vision) */
	input?: string[];
	/**
	 * Per-level provider mapping straight off the agent's Model object. `null`
	 * means the level is unsupported; a missing "xhigh"/"max" key means the same.
	 * This is the only honest source for the brain menu — the level list is a
	 * property of the model, not a constant (Kimi K3 TEE supports "max" alone).
	 */
	thinkingLevelMap?: Record<string, string | null> | null;
}

export interface RpcSessionState {
	model?: RpcModel | null;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	steeringMode?: string;
	followUpMode?: string;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	autoCompactionEnabled?: boolean;
	messageCount?: number;
}

export interface SessionChild {
	/** bare id (uuid or sub-xxxx) for display */
	id: string;
	/** daemon attach target (12-char active id, or the id when resident); display only. */
	activeSessionId: string;
	/** Opaque host-issued capability required to browse this rendered child. */
	browseRef?: string;
	name?: string;
	runtimeKind?: string;
	rlmDepth?: number;
	created?: string;
	isStreaming?: boolean;
	/**
	 * Roster status, mirroring the CLI's classifySessionRosterStatus.
	 * "inactive" means the daemon serves this one from its on-disk registry — it
	 * finished and is not resident, which `isStreaming: false` alone cannot say
	 * (a resident subagent between turns reports exactly the same bit).
	 */
	status?: "running" | "idle" | "inactive";
	/** Exceptional off-nominal state the daemon flags: "queued" | "recovering" | "failed". */
	statusLabel?: string;
	attachedClients?: number;
}

export interface FileSearchItem {
	path: string;
	isDir: boolean;
}

export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export interface RpcSessionStats {
	sessionFile?: string;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	totalMessages?: number;
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost?: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

// ---------------------------------------------------------------------------
// Extension UI requests emitted by agent extensions that need user input
// ---------------------------------------------------------------------------

export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: string }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcOutbound = RpcExtensionUIRequest | AgentEvent | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Extension host <-> webview message bus
// ---------------------------------------------------------------------------

export interface ImageAttachment {
	data: string;
	mimeType: string;
	name?: string;
}

export interface SelectionAttachment {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	languageId: string;
}

export interface PromptPayload {
	text: string;
	images: ImageAttachment[];
	selections: SelectionAttachment[];
	/** delivery behavior while the agent is streaming */
	streamingBehavior: "steer" | "followUp";
	/** Correlates an optimistic webview row with its eventual transport verdict. */
	clientRequestId?: string;
}

export type WebviewToHost =
	| { type: "ready" }
	| { type: "prompt"; payload: PromptPayload }
	| { type: "abort" }
	| { type: "newSession" }
	| { type: "compact"; instructions?: string }
	| { type: "exportHtml" }
	| { type: "exportChat" }
	| { type: "restart" }
	| { type: "requestState" }
	| { type: "requestModels" }
	| { type: "requestCommands" }
	| { type: "requestHistory" }
	| { type: "searchHistory"; query: string }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: string }
	| { type: "switchSession"; path: string; sessionId: string }
	| { type: "stopObserving" }
	| { type: "deleteSession"; path: string; sessionId: string }
	| { type: "searchFiles"; query: string; requestId: number }
	| { type: "openFile"; path: string; startLine?: number; endLine?: number }
	| { type: "openDiff"; path: string }
	| { type: "pickImage"; requestId: number }
	| { type: "attachActiveFile" }
	| { type: "attachSelection" }
	| { type: "pickModel" }
	| { type: "pickThinkingLevel" }
	| { type: "toggleFavoriteModel"; provider: string; modelId: string }
	| { type: "browseChild"; browseRef: string }
	| { type: "backToParent" }
	| { type: "forkFromUser"; ordinal: number }
	| { type: "copyConversation" }
	| { type: "dismissInstallPrompt" }
	| { type: "renameSession"; name: string }
	| { type: "noticeAction"; id: string }
	| { type: "renameHistorySession"; path: string; sessionId: string; name: string }
	| { type: "stopSession"; path: string; sessionId: string }
	| { type: "archiveSession"; path: string; sessionId: string }
	| { type: "draftChanged"; text: string; sessionId: string }
	| { type: "setCompactThreshold"; percent: number | null }
	| { type: "openExternal"; url: string };

export interface StatusSnapshot {
	connected: boolean;
	streaming: boolean;
	compacting: boolean;
	retrying: boolean;
	restoring: boolean;
	modelLabel: string;
	thinkingLevel: string;
	availableThinkingLevels?: string[] | null;
	sessionName?: string;
	sessionFile?: string;
	sessionId?: string;
	statsText: string;
	statusText?: string;
	compactThresholdPercent?: number | null;
	compactDefaultPercent?: number | null;
	usageTotal?: number;
	costUsd?: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	modelProvider?: string;
	modelId?: string;
	/** Session id currently being observed read-only, or null when attached normally */
	observingId?: string | null;
}

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface RecentSession {
	/** Session id (jsonl filename stem); used for observe/resume */
	id: string;
	path: string;
	cwd: string;
	timestamp: string;
	/** Filesystem mtime in ms — the true "last activity" signal (renames/forks move it). */
	modifiedMs?: number;
	/** True when the daemon reports this session is actively streaming rn. */
	running?: boolean;
	/**
	 * Roster status, the same three the CLI's agents view names: a session with
	 * no live worker is "inactive", one whose worker is doing something is
	 * "running", and one holding a worker between turns is "idle". `running`
	 * stays for the controls that only care whether there is a run to stop.
	 */
	status?: "running" | "idle" | "inactive";
	/** Exceptional off-nominal state the daemon flags: "queued" | "recovering" | "failed". */
	statusLabel?: string;
	name?: string;
	firstPrompt?: string;
	inWorkspace: boolean;
	/**
	 * Excerpt of the conversation that matched the current search, from the
	 * daemon's `allMessagesText`. Present only on rows a host-side search found
	 * by message body — it is both the evidence for the hit and what makes the
	 * row rank in the webview's own filter, which cannot see the transcript.
	 */
	matchSnippet?: string;
}

export type HostToWebview =
	| {
			type: "snapshot";
			messages: AgentMessage[];
			state: RpcSessionState | null;
			status: StatusSnapshot;
			steerDefault?: "steer" | "followUp";
		}
	| { type: "favorites"; favorites: ModelRef[] }
	| { type: "sessionChildren"; children: SessionChild[]; parent?: SessionChild; siblings?: SessionChild[]; viewedActiveSessionId?: string; spawned?: Array<{ activeSessionId: string; browseRef?: string; name?: string; created?: string }> }
	| { type: "installPrompt"; url: string; reason: string }
	| ThreadDiffsMessage
	| { type: "draft"; text: string }
	| { type: "compactThreshold"; percent: number | null; defaultPercent?: number | null }
	| { type: "event"; event: AgentEvent }
	| { type: "status"; status: StatusSnapshot }
	| { type: "models"; models: RpcModel[] }
	| { type: "commands"; commands: RpcSlashCommand[] }
	| { type: "history"; sessions: RecentSession[] }
	| { type: "showHistory" }
	| { type: "promptAccepted"; kind: "prompt" | "steer" | "followUp" }
	| { type: "promptRejected"; error: string; clientRequestId?: string }
	| {
			type: "notice";
			level: "info" | "warning" | "error";
			text: string;
			/**
			 * Optional one-shot recovery the operator can run from the notice. `id`
			 * is an opaque host-issued capability, like a subagent's `browseRef`:
			 * the webview can only ask the host to run something the host already
			 * decided to offer.
			 */
			action?: { id: string; label: string };
	  }
	| { type: "uiState"; statusText?: string; title?: string }
	| { type: "fileSearchResults"; requestId: number; files: FileSearchItem[] }
	| { type: "imagePicked"; requestId: number; images: ImageAttachment[] }
	| { type: "insertSelection"; selection: SelectionAttachment }
	| { type: "insertMention"; path: string }
	| { type: "changedFiles"; files: string[] }
	| { type: "observedSession"; sessionId: string; messages: AgentMessage[] }
	| { type: "observedEvent"; sessionId: string; event: AgentEvent }
	| { type: "observedClosed"; sessionId: string }
	| { type: "editorText"; text: string }
	| { type: "focusComposer" };

// ---------------------------------------------------------------------------
// Per-thread diff panel (host -> webview)
// ---------------------------------------------------------------------------

/**
 * How the change was captured. Practically always `edit`: prime-agent registers
 * exactly one tool (`ipython`) and the hunks come from the diff payloads its
 * bundled `edit` skill publishes. `write` only appears when an extension
 * registers a tool of that name. There is deliberately no `shell` source — a
 * shell command carries no before/after content, so claiming it changed a file
 * would be a guess.
 */
export type ThreadDiffSource = "edit" | "write";

/** One stitched change block per recorded edit on a file. */
export interface ThreadDiffHunk {
	/** Removed lines (rendered with a red "-" gutter). */
	removed: string[];
	/** Added lines (rendered with a green "+" gutter). */
	added: string[];
	/** Optional gutter note rendered after the hunk (e.g. line-cap truncation). */
	note?: string;
	/** Subagent that made this change; absent means the viewed session's own agent. */
	agent?: string;
}

export interface ThreadDiffFile {
	/** Workspace-relative path, validated by the extension host. */
	path: string;
	/** Source of the most recent recorded change. */
	viaSource: ThreadDiffSource;
	/** Stitched change blocks, one per recorded edit, in event order. */
	hunks: ThreadDiffHunk[];
}

/** Cumulative per-thread diff state; `files` empty hides the panel. */
export interface ThreadDiffsMessage {
	type: "threadDiffs";
	files: ThreadDiffFile[];
}
