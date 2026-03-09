import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { SKILLS_DIR } from '../config/loader.js';
import type { LLMParams, LLMResponse, ToolDefinition } from '../llm/types.js';
import type { SkillContext } from './types.js';

// Use the exact node binary that's running the gateway + the TypeScript JS directly.
// This bypasses /usr/bin/env lookups that fail in systemd's restricted PATH.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const NODE_BIN   = process.execPath;  // e.g. /home/user/.nvm/versions/node/v20.x/bin/node
const TSC_SCRIPT = path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');

export interface SelfWriteArgs {
  skill_name: string;
  description: string;
  tools_needed: string;
  implementation_notes: string;
}

export interface SelfWriteTool {
  toolDef: ToolDefinition;
  execute: (args: SelfWriteArgs, ctx: SkillContext) => Promise<{ installed: boolean; skill_name: string }>;
}

const SKILL_GENERATOR_PROMPT = (args: SelfWriteArgs) => `
You are a TypeScript skill generator for the AURA Gateway.

Generate a skill named "${args.skill_name}" with this description: ${args.description}
Tools needed: ${args.tools_needed}
Implementation notes: ${args.implementation_notes}

Respond with ONLY valid JSON in this exact format:
{
  "yaml_content": "<the full YAML skill definition>",
  "ts_content": "<the full TypeScript executor content>"
}

YAML must follow this schema:
name: ${args.skill_name}
version: 1.0.0
description: <description>
executor: ${args.skill_name}.ts
enabled: true
source: self_written
requires_env: []
tools:
  - name: <tool_name>
    description: <when to call>
    parameters:
      type: object
      properties:
        <param>: { type: string, description: <what> }
      required: [<param>]

TypeScript executor must export async functions matching each tool name:
export async function <tool_name>(args: { <params> }, _ctx: unknown): Promise<unknown> { ... }

SAFETY RULES (CRITICAL):
- Do NOT use shell/exec commands in the executor
- Do NOT import or call create_skill recursively
- Keep implementation simple and focused
`.trim();

/**
 * Creates the self-write tool with dependency-injected LLM completion.
 * This allows the tool to generate new skills without importing LLMRouter.
 */
export function createSelfWriteTool(
  llmComplete: (params: LLMParams) => Promise<LLMResponse>
): SelfWriteTool {
  const toolDef: ToolDefinition = {
    name: 'create_skill',
    description: 'Creates and installs a new skill from a description. The skill becomes immediately available after installation. IMPORTANT: This is the ONLY correct way to create skills — never manually write skill files to the workspace or anywhere else. Skills are installed directly to ~/.aura/skills/ automatically.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'snake_case name for the new skill (e.g., ip_address)',
        },
        description: {
          type: 'string',
          description: 'What this skill should do',
        },
        tools_needed: {
          type: 'string',
          description: 'What tools, APIs, or capabilities this skill needs',
        },
        implementation_notes: {
          type: 'string',
          description: 'Implementation hints and requirements',
        },
      },
      required: ['skill_name', 'description', 'tools_needed', 'implementation_notes'],
    },
  };

  const execute = async (
    args: SelfWriteArgs,
    _ctx: SkillContext
  ): Promise<{ installed: boolean; skill_name: string }> => {
    console.log(`[SelfWrite] Generating files for: ${args.skill_name}`);

    // 1. Ask LLM to generate YAML + TS
    const response = await llmComplete({
      system: 'You are a TypeScript skill generator. Respond with valid JSON only.',
      messages: [{ role: 'user', content: SKILL_GENERATOR_PROMPT(args) }],
      max_tokens: 4096,
    });

    let parsed: { yaml_content: string; ts_content: string };
    try {
      // Extract JSON from response (may have markdown code fences)
      const jsonStr = response.text
        .replace(/^```json\s*/m, '')
        .replace(/^```\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();
      parsed = JSON.parse(jsonStr) as { yaml_content: string; ts_content: string };
    } catch (err) {
      throw new Error(`[SelfWrite] Failed to parse LLM response as JSON: ${String(err)}`);
    }

    // 2. Write to temp files
    const tmpYaml = `/tmp/${args.skill_name}.yaml`;
    const tmpTs = `/tmp/${args.skill_name}.ts`;
    fs.writeFileSync(tmpYaml, parsed.yaml_content, 'utf8');
    fs.writeFileSync(tmpTs, parsed.ts_content, 'utf8');

    // 3. TypeScript validation — must pass before saving
    try {
      execSync(`"${NODE_BIN}" "${TSC_SCRIPT}" --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler ${tmpTs}`, {
        stdio: 'pipe',
      });
      console.log('[SelfWrite] TypeScript validation passed');
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
      const errMsg = e.stdout?.toString().trim() || e.stderr?.toString().trim() || e.message || String(err);
      throw new Error(`[SelfWrite] TypeScript validation failed:\n${errMsg}`);
    }

    // 4. Duplicate tool name check — reject if any tool name already exists in an enabled skill
    let newSkillYaml: { tools?: Array<{ name: string }> } = {};
    try { newSkillYaml = yaml.load(parsed.yaml_content) as typeof newSkillYaml; } catch { /* checked below */ }
    const newToolNames = (newSkillYaml.tools ?? []).map(t => t.name);
    if (newToolNames.length > 0 && fs.existsSync(SKILLS_DIR)) {
      const existingTools = new Map<string, string>(); // tool_name → skill_name
      for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.yaml') && f !== `${args.skill_name}.yaml`)) {
        try {
          const s = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')) as { name?: string; enabled?: boolean; tools?: Array<{ name: string }> };
          if (s?.enabled === false) continue;
          for (const t of s?.tools ?? []) existingTools.set(t.name, s.name ?? f);
        } catch { /* skip unreadable */ }
      }
      const clashes = newToolNames.filter(n => existingTools.has(n));
      if (clashes.length > 0) {
        const detail = clashes.map(n => `"${n}" (already in skill "${existingTools.get(n)}"`).join(', ');
        throw new Error(`[SelfWrite] Duplicate tool names detected: ${detail}). Rename these tools before installing.`);
      }
    }

    // 5. Move to skills dir — chokidar auto-loads
    if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.copyFileSync(tmpYaml, path.join(SKILLS_DIR, `${args.skill_name}.yaml`));
    fs.copyFileSync(tmpTs, path.join(SKILLS_DIR, `${args.skill_name}.ts`));

    console.log(`[SelfWrite] Saved ${args.skill_name}.yaml + .ts to ${SKILLS_DIR}`);

    // 6. Auto-assign to the agent so it's immediately available — no need to call skill_add manually
    const agentsPath = path.join(path.dirname(SKILLS_DIR), 'agents.yaml');
    try {
      const agentsRaw  = fs.readFileSync(agentsPath, 'utf8');
      const agentsData = (await import('js-yaml')).load(agentsRaw) as { agents: Array<Record<string, unknown>> };
      let assigned = false;
      for (const agent of agentsData.agents ?? []) {
        const agentSkills = (agent['skills'] as string[] | undefined) ?? [];
        if (!agentSkills.includes(args.skill_name) && agent['id'] !== 'default') {
          agentSkills.push(args.skill_name);
          agent['skills'] = agentSkills;
          assigned = true;
        }
      }
      if (assigned) {
        const { dump } = await import('js-yaml');
        fs.writeFileSync(agentsPath, dump(agentsData, { lineWidth: 120 }), 'utf8');
        console.log(`[SelfWrite] Auto-assigned ${args.skill_name} to agent`);
      }
    } catch (err) {
      console.warn(`[SelfWrite] Could not auto-assign skill to agent: ${err}`);
    }

    return { installed: true, skill_name: args.skill_name };
  };

  return { toolDef, execute };
}
