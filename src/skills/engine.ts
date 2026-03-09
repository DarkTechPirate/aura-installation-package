import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import { SKILLS_DIR } from '../config/loader.js';
import { SkillRegistry } from './registry.js';
import { executeSkillTool } from './executor.js';
import type { SkillDefinition, SkillContext } from './types.js';
import type { ToolDefinition } from '../llm/types.js';

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
      console.log('[Skills] Created skills directory:', SKILLS_DIR);
      return;
    }

    const yamlFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.yaml'));
    let loaded = 0;

    for (const file of yamlFiles) {
      try {
        const fullPath = path.join(SKILLS_DIR, file);
        const raw = fs.readFileSync(fullPath, 'utf8');
        const def = yaml.load(raw) as SkillDefinition;
        if (def?.name) {
          this.registry.register(def);
          loaded++;
        }
      } catch (err) {
        console.error(`[Skills] Failed to load ${file}:`, err);
      }
    }

    console.log(`[Skills] Loaded ${loaded} skills`);
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
        console.log(`[Skills] Executor updated, cache invalidated: ${path.basename(filePath)}`);
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
      const raw = fs.readFileSync(yamlPath, 'utf8');
      const def = yaml.load(raw) as SkillDefinition;
      if (def?.name) {
        this.registry.register(def);
        console.log(`[Skills] Reloaded: ${def.name}${def.source === 'self_written' ? ' (source: self_written)' : ''}`);
        this.changeCallback?.();
      }
    } catch (err) {
      console.error(`[Skills] Failed to reload ${yamlPath}:`, err);
    }
  }
}
