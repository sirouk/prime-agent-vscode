/**
 * Agent identity accents are derived from the daemon session UUID. The UUID is
 * already random: hashing it gives each agent a persistent, varied accent with
 * no settings writes or per-render randomness. Names, status and attach handles
 * never affect the color when a stable session identity is available.
 *
 * These values are display-only. Navigation always uses a host browseRef.
 */
export interface AgentIdentity {
	sessionId?: string;
	activeSessionId?: string;
	id?: string;
}

// An older/partial roster may omit a UUID we already learned. Remember it for
// display only; a newly supplied UUID always replaces the handle's old alias.
const knownSessionIds = new Map<string, string>();

export function rememberAgentIdentities(agents: readonly AgentIdentity[]): void {
	for (const agent of agents) {
		const handle = agent.activeSessionId || agent.id || "";
		if (handle && agent.sessionId) knownSessionIds.set(handle, agent.sessionId);
	}
}

export function agentIdentityKey(agent: AgentIdentity): string {
	const handle = agent.activeSessionId || agent.id || "";
	return agent.sessionId || knownSessionIds.get(handle) || handle;
}

export function applyAgentIdentity(node: HTMLElement, agent: AgentIdentity): void {
	const key = agentIdentityKey(agent);
	if (!key) {
		clearAgentIdentity(node);
		return;
	}
	let hash = 2166136261;
	for (let i = 0; i < key.length; i += 1) {
		hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
	}
	// Mix nearby UUID suffixes too, so sequential-looking ids don't look alike.
	hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
	hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
	hash = (hash ^ (hash >>> 16)) >>> 0;
	const hue = hash % 360;
	const saturation = 58 + ((hash >>> 9) % 3) * 7;
	node.classList.add("agent-identity");
	node.dataset.agentKey = key;
	node.style.setProperty("--agent-color-dark", `hsl(${hue} ${saturation}% 72%)`);
	node.style.setProperty("--agent-color-light", `hsl(${hue} ${saturation}% 28%)`);
}

export function clearAgentIdentity(node: HTMLElement): void {
	node.classList.remove("agent-identity");
	delete node.dataset.agentKey;
	node.style.removeProperty("--agent-color-dark");
	node.style.removeProperty("--agent-color-light");
}
