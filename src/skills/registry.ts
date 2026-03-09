import type { SkillDefinition } from './types.js';

/**
 * In-memory registry of loaded skill definitions.
 */
export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  unregister(name: string): void {
    this.skills.delete(name);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  getEnabled(): SkillDefinition[] {
    return this.getAll().filter(s => s.enabled);
  }
}
