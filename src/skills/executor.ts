import type { SkillContext } from './types.js';

/**
 * Dynamically imports a skill executor file and invokes the named tool function.
 * A cache-bust token is appended to the import path so that when a .ts executor
 * file is updated on disk the new version is loaded rather than the stale cache.
 */
export async function executeSkillTool(
  executorPath: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx: SkillContext,
  cacheBust = 0,
): Promise<unknown> {
  let mod: Record<string, unknown>;
  try {
    const importPath = cacheBust > 0 ? `${executorPath}?t=${cacheBust}` : executorPath;
    mod = await import(importPath) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to import skill executor '${executorPath}': ${String(err)}`);
  }

  const fn = mod[toolName];
  if (typeof fn !== 'function') {
    throw new Error(`Tool '${toolName}' not found in executor '${executorPath}'. Available exports: ${Object.keys(mod).join(', ')}`);
  }

  return fn(args, ctx);
}
