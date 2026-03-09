import type { AgentConfig } from './types.js';

/**
 * Resolves the correct agent for a given node_id.
 * Resolution order:
 *  1. Exact match in channels[]
 *  2. Prefix match (e.g. node_id 'slack_U0123' matches agent with 'slack_dev_dm')
 *  3. Default fallback (agent with '__default__' in channels)
 *  4. First agent as last resort
 */
export function resolveAgent(node_id: string, agents: AgentConfig[]): AgentConfig {
  // 1. Exact match
  const exact = agents.find(a => a.channels.includes(node_id));
  if (exact) return exact;

  // 2. Prefix match: node_id starts with same prefix as any channel entry
  const nodePrefix = node_id.split('_')[0];
  if (nodePrefix) {
    const prefix = agents.find(a =>
      a.channels.some(ch => {
        if (ch === '__default__') return false;
        const chPrefix = ch.split('_')[0];
        return chPrefix === nodePrefix;
      })
    );
    if (prefix) return prefix;
  }

  // 3. Default agent
  const def = agents.find(a => a.channels.includes('__default__'));
  if (def) return def;

  // 4. Last resort
  return agents[0]!;
}
