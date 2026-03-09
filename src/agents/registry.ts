import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentConfig } from './types.js';
import { resolveAgent } from './resolver.js';

/**
 * In-memory registry of loaded agent configurations.
 * Supports hot-reload via chokidar file watching.
 */
export class AgentRegistry {
  private agents: AgentConfig[] = [];

  load(agents: AgentConfig[]): void {
    this.agents = agents;
  }

  /**
   * Resolves the correct agent for a node_id using:
   * exact match → prefix match → default → first
   */
  resolve(node_id: string): AgentConfig {
    return resolveAgent(node_id, this.agents);
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.find(a => a.id === id);
  }

  getAll(): AgentConfig[] {
    return [...this.agents];
  }
}

/**
 * Watches an agents.yaml file and reloads the registry on change.
 */
export function watchAgents(
  registry: AgentRegistry,
  filePath: string,
  reloadFn: () => AgentConfig[]
): FSWatcher {
  const watcher = chokidar.watch(filePath, { ignoreInitial: true });
  watcher.on('change', () => {
    try {
      const agents = reloadFn();
      registry.load(agents);
      console.log(`[Agents] Reloaded ${agents.length} agents from ${filePath}`);
    } catch (err) {
      console.error('[Agents] Failed to reload agents.yaml:', err);
    }
  });
  return watcher;
}
