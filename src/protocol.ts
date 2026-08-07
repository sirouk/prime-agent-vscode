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
	cost?: { total: number };
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

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
	timestamp?: number;
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
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: string }
	| { type: "switchSession"; path: string; sessionId?: string }
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
	| { type: "forkFromUser"; ordinal: number }
	| { type: "copyConversation" }
	| { type: "draftChanged"; text: string }
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
	sessionName?: string;
	sessionFile?: string;
	sessionId?: string;
	statsText: string;
	statusText?: string;
	compactThresholdPercent?: number | null;
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
	name?: string;
	firstPrompt?: string;
	inWorkspace: boolean;
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
	| { type: "draft"; text: string }
	| { type: "compactThreshold"; percent: number | null }
	| { type: "event"; event: AgentEvent }
	| { type: "status"; status: StatusSnapshot }
	| { type: "models"; models: RpcModel[] }
	| { type: "commands"; commands: RpcSlashCommand[] }
	| { type: "history"; sessions: RecentSession[] }
	| { type: "showHistory" }
	| { type: "promptAccepted"; kind: "prompt" | "steer" | "followUp" }
	| { type: "promptRejected"; error: string }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "uiState"; statusText?: string; title?: string }
	| { type: "fileSearchResults"; requestId: number; files: string[] }
	| { type: "imagePicked"; requestId: number; images: ImageAttachment[] }
	| { type: "insertSelection"; selection: SelectionAttachment }
	| { type: "insertMention"; path: string }
	| { type: "changedFiles"; files: string[] }
	| { type: "observedSession"; sessionId: string; messages: AgentMessage[] }
	| { type: "observedEvent"; sessionId: string; event: AgentEvent }
	| { type: "observedClosed"; sessionId: string }
	| { type: "editorText"; text: string }
	| { type: "focusComposer" };
