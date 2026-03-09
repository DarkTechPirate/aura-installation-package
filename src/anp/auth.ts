import { loadNodes } from '../config/loader.js';

/**
 * Validates a node's token against the nodes.yaml registry.
 */
export function validateToken(node_id: string, token: string): boolean {
  const config = loadNodes();
  const node = config.nodes.find(n => n.id === node_id);
  return !!node && node.token === token;
}

/**
 * Returns the declared capabilities for a node.
 */
export function getNodeCaps(node_id: string): string[] {
  const config = loadNodes();
  return config.nodes.find(n => n.id === node_id)?.caps ?? [];
}
