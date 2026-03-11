/**
 * BlocksRegistry — reusable agent template store (OpenProse-style `block:` definitions).
 * Blocks are named SubAgentSpec templates; agents referencing a block inherit its
 * defaults (role, task, tools) while allowing per-call overrides.
 */

export interface BlockSpec {
  role:   string;
  task:   string;
  tools?: string[];
}

export class BlocksRegistry {
  private store = new Map<string, BlockSpec>();

  define(name: string, spec: BlockSpec): void {
    this.store.set(name, { ...spec });
  }

  get(name: string): BlockSpec | undefined {
    return this.store.get(name);
  }

  list(): Array<{ name: string } & BlockSpec> {
    return Array.from(this.store.entries()).map(([name, spec]) => ({ name, ...spec }));
  }
}
