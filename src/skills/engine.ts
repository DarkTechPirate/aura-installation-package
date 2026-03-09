import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import chokidar from 'chokidar';
import { SKILLS_DIR } from '../config/loader.js';
import { SkillRegistry } from './registry.js';
import { executeSkillTool } from './executor.js';
import type { SkillDefinition, SkillContext } from './types.js';
import type { ToolDefinition } from '../llm/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Skills');

// ── Skill YAML schema — invalid skills are skipped, not crash ────────────────
const SkillToolSchema = z.object({
  name:        z.string().min(1),
  description: z.string().min(1),
  parameters:  z.record(z.string(), z.unknown()).default({}),
});

const SkillDefinitionSchema = z.object({
  name:         z.string().min(1),
  version:      z.string().default('1.0.0'),
  description:  z.string().default(''),
  executor:     z.string().min(1),
  enabled:      z.boolean().default(true),
  source:       z.enum(['human', 'self_written']).default('human'),
  requires_env: z.array(z.string()).default([]),
  tools:        z.array(SkillToolSchema).min(1),
});

/**
 * Loads, hot-reloads, and executes skill definitions from ~/.aura/skills/.
 */
export class SkillsEngine {
  private registry = new SkillRegistry();
  private watcher:   ReturnType<typeof chokidar.watch> | null = null;
  private executorVersions = new Map<string, number>(); // executor path → cache-bust token
  private changeCallback: (() => void) | null = null;

  /** Register a callback to be called whenever a skill is added or reloaded. */
  onSkillsChanged(cb: () => void): void {
    this.changeCallback = cb;
  }

  async load(): Promise<void> {
    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      logger.info('Created skills directory', { path: SKILLS_DIR });
      return;
    }

    const yamlFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.yaml'));
    let loaded = 0;

    for (const file of yamlFiles) {
      try {
        const fullPath = path.join(SKILLS_DIR, file);
        const raw      = fs.readFileSync(fullPath, 'utf8');
        const parsed   = SkillDefinitionSchema.safeParse(yaml.load(raw));
        if (!parsed.success) {
          const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
          logger.warn('Skipping invalid skill YAML', { file, issues });
          continue;
        }
        this.registry.register(parsed.data as SkillDefinition);
        loaded++;
      } catch (err) {
        logger.error(`Failed to load skill`, { file, error: String(err) });
      }
    }

    logger.info(`Loaded ${loaded} skills`);
  }

  listSkills(): SkillDefinition[] {
    return this.registry.getAll();
  }

  /**
   * Returns ToolDefinition[] for the given skill names (or all enabled skills if empty).
   */
  getToolDefs(skill_names: string[]): ToolDefinition[] {
    const skills = skill_names.length > 0
      ? skill_names.flatMap(n => {
          const s = this.registry.get(n);
          return s && s.enabled ? [s] : [];
        })
      : this.registry.getEnabled();

    return skills.flatMap(s =>
      s.tools.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  t.parameters,
      }))
    );
  }

  /**
   * Executes a tool call by finding which skill owns it and calling its executor.
   */
  async execute(
    tool_name: string,
    args: Record<string, unknown>,
    ctx: SkillContext
  ): Promise<unknown> {
    const skill = this.registry.getAll().find(s => s.tools.some(t => t.name === tool_name));
    if (!skill) {
      throw new Error(`Tool '${tool_name}' not found in any loaded skill`);
    }
    if (!skill.enabled) {
      throw new Error(`Skill '${skill.name}' is disabled`);
    }

    const executorPath = path.join(SKILLS_DIR, skill.executor);
    const cacheBust    = this.executorVersions.get(executorPath) ?? 0;
    return executeSkillTool(executorPath, tool_name, args, ctx, cacheBust);
  }

  watchSkillsDir(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(SKILLS_DIR, { ignoreInitial: true });
    this.watcher.on('change', async (filePath) => {
      if (filePath.endsWith('.yaml')) {
        await this.reloadSkill(filePath);
      } else if (filePath.endsWith('.ts') || filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
        // Bump the cache-bust token so next executeSkillTool call imports the fresh module
        this.executorVersions.set(filePath, Date.now());
        logger.info('Executor updated, cache invalidated', { file: path.basename(filePath) });
      }
    });
    this.watcher.on('add', async (filePath) => {
      if (filePath.endsWith('.yaml')) {
        await this.reloadSkill(filePath);
      }
    });
  }

  async reload(): Promise<void> {
    this.registry = new SkillRegistry();
    await this.load();
  }

  private async reloadSkill(yamlPath: string): Promise<void> {
    try {
      const raw    = fs.readFileSync(yamlPath, 'utf8');
      const parsed = SkillDefinitionSchema.safeParse(yaml.load(raw));
      if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        logger.warn('Skipping invalid skill YAML on reload', { path: yamlPath, issues });
        return;
      }
      const def = parsed.data as SkillDefinition;
      this.registry.register(def);
      logger.info('Reloaded skill', { name: def.name, source: def.source ?? 'human' });
      this.changeCallback?.();
    } catch (err) {
      logger.error('Failed to reload skill', { path: yamlPath, error: String(err) });
    }
  }
}
