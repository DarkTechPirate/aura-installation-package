import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ANPEvent } from '../anp/types.js';
import type { AgentConfig } from '../agents/types.js';
import type { LLMMessage, LLMParams, ToolDefinition } from './types.js';
import type { GatewayConfig } from '../config/loader.js';

const CONTACTS_FILE = path.join(os.homedir(), '.aura', 'workspace', 'contacts.md');

// Module-level mtime cache — contacts.md rarely changes so no need to hit disk every message.
let _contactsCache: { content: string; mtime: number } | null = null;

function readContactsFile(): string {
  try {
    if (!fs.existsSync(CONTACTS_FILE)) return '';
    const mtime = fs.statSync(CONTACTS_FILE).mtimeMs;
    if (_contactsCache && _contactsCache.mtime === mtime) return _contactsCache.content;
    const content = fs.readFileSync(CONTACTS_FILE, 'utf8');
    _contactsCache = { content, mtime };
    return content;
  } catch { return ''; }
}

/** Look up a sender name from contacts.md by node_id or chat_id. Returns null if not found. */
function lookupSender(nodeId: string): { name: string; notes?: string } | null {
  try {
    const raw = readContactsFile();
    if (!raw) return null;
    const chatId = nodeId.replace(/^[a-z_]+_/, ''); // e.g. telegram_1012325503 → 1012325503
    for (const line of raw.split('\n')) {
      // Match markdown table rows: | Name | chat_id | node_id | ... |
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 3) continue;
      if (cols[2] === nodeId || cols[1] === chatId) {
        return { name: cols[0]!, notes: cols[4] ?? undefined };
      }
    }
  } catch { /* non-fatal */ }
  return null;
}

const MAX_MESSAGES = 12;

export interface ContextBuildParams {
  event:        ANPEvent;
  agent:        AgentConfig;
  shortTerm:    LLMMessage[];
  semanticHits: string[];
  toolDefs:     ToolDefinition[];
  config:       GatewayConfig;
  userProfile:  string;
  selfKnowledge: string;
  /** All installed skills (name + description) for awareness. */
  installedSkills?: Array<{ name: string; description: string }>;
  /** Skill names that are installed but not loaded this turn (keyword not matched). */
  unloadedSkillNames?: string[];
}

/**
 * Assembles the LLM system prompt, message history, and tool definitions
 * for a given ANP utterance event and agent configuration.
 */
export class ContextBuilder {
  async build(params: ContextBuildParams): Promise<LLMParams> {
    const { event, agent, shortTerm, semanticHits, toolDefs, config, userProfile, selfKnowledge, installedSkills, unloadedSkillNames } = params;

    // ── Identity & persona ────────────────────────────────────────────────────
    let system = agent.persona.trim();

    // Hard identity rule — prevent the model from describing itself as the
    // underlying LLM when asked "what are you" or "what can you do".
    system += `\n\nYour name is ${agent.name}. You are a personal AI assistant.`;

    // ── Sender identity ───────────────────────────────────────────────────────
    // Look up who is messaging from contacts.md so Gary always knows the sender.
    const sender = lookupSender(event.node_id);
    if (sender) {
      system += `\n\nYou are currently talking with: ${sender.name} (node_id: ${event.node_id})`;
      if (sender.notes) system += ` — Notes: ${sender.notes}`;
    } else {
      system += `\n\nYou are currently talking with: unknown contact (node_id: ${event.node_id})`;
      system += `\nIf they introduce themselves, save them to contacts.md using the filesystem skill.`;
    }
    system += `\nNever mention, reveal, or discuss the AI model, LLM provider, or ` +
              `technology powering you. If asked, say you are ${agent.name} and describe ` +
              `your capabilities below — nothing more.`;

    // ── Capabilities hint ─────────────────────────────────────────────────────
    // Tool definitions are already sent in the tools array — no need to repeat them here.
    // Just tell the agent how to describe itself when asked.
    if (toolDefs.length > 0) {
      system += `\n\nYou have tools available. When asked what you can do, describe your ` +
                `capabilities naturally — do not list raw tool names. Always mention you can ` +
                `message Telegram contacts and create new skills on the fly.`;
    }

    // ── Gateway self-awareness ────────────────────────────────────────────────
    // Tell the agent about its own infrastructure so it can answer accurately
    // when users ask about ports, endpoints, or the system's status.
    const bind     = config.security.bind_address ?? '127.0.0.1';
    const restPort = config.security.rest_port   ?? 3002;
    const anpPort  = config.security.anp_port    ?? 8765;
    const wcPort   = (config.channels['webchat']?.['port'] as number | undefined) ?? 3000;
    const cvPort   = config.canvas.port          ?? 3001;

    system += `\n\nYou are running as the AURA Gateway on this machine. Your own endpoints:`;
    system += `\n- REST API (webhooks, status, reminders): http://${bind}:${restPort}`;
    system += `\n- ANP WebSocket (agent protocol):         ws://${bind}:${anpPort}/anp`;
    system += `\n- WebChat WebSocket (browser UI):         ws://${bind}:${wcPort}`;
    system += `\n- Canvas WebSocket (live canvas):         ws://${bind}:${cvPort}/canvas`;
    system += `\n- EC2 Control Panel (visual dashboard):  http://${bind}:${restPort}/dashboard2`;
    system += `\n- LLM Config Dashboard:                  http://${bind}:${restPort}/dashboard`;
    system += `\nWhen the user asks about a port or service, refer to the above — ` +
              `port ${restPort} is YOUR REST API, not an external webhook receiver.`;
    system += `\n\nEC2 Dashboard API (use these when working with ec2_workflow_automation):`;
    system += `\n- View live workflows:  GET  http://${bind}:${restPort}/dashboard2/api/workflows`;
    system += `\n- Run a workflow:       POST http://${bind}:${restPort}/dashboard2/api/run  { name, steps[] }`;
    system += `\n- Load templates:       GET  http://${bind}:${restPort}/dashboard2/api/templates`;
    system += `\nAlways tell the user to open http://${bind}:${restPort}/dashboard2 to see live workflow status.`;

    // ── Live channel connections ───────────────────────────────────────────────
    // Tell the agent exactly which channels are active and what node_ids to use,
    // so it never has to guess when the user asks it to send a message.
    const enabledChannels = Object.entries(config.channels)
      .filter(([, cfg]) => (cfg as Record<string, unknown>)['enabled'] === true)
      .map(([name]) => name);

    system += `\n\nYour active channels (you can send messages to these right now):`;
    for (const ch of enabledChannels) {
      const chCfg = config.channels[ch] as Record<string, unknown>;
      if (ch === 'webchat') {
        system += `\n- webchat (browser UI at port ${wcPort})`;
      } else if (ch === 'telegram') {
        const ids = (chCfg['allowed_ids'] as (string | number)[] | undefined) ?? [];
        system += `\n- telegram — send_message node_id format: telegram_<chat_id>`;
        if (ids.length > 0) {
          system += `\n  Authorised chat IDs: ${ids.join(', ')}`;
          system += `\n  To text the user: send_message({ node_id: "telegram_${ids[0]}", text: "..." })`;
        }
      } else {
        system += `\n- ${ch}`;
      }
    }
    system += `\n\nYour assigned channels (from agents.yaml): ${agent.channels.filter(c => c !== '__default__').join(', ') || 'none explicitly assigned'}`;
    system += `\nYour config and allowed IDs are in ~/.aura/config.yaml — use config_read or allowed_ids_add/remove to inspect or change them.`;

    // ── Agent behaviour rules (sourced from Cursor, Windsurf, Gemini CLI) ────────
    system += `\n\nAGENT BEHAVIOUR (follow these at all times):`;
    system += `\n- Complete the user's request fully before stopping. Do not ask clarifying questions if you can find the answer yourself using your tools.`;
    system += `\n- Call tools only when necessary. If you already know the answer, reply directly without using a tool.`;
    system += `\n- Before running any shell command or file operation that modifies state, briefly state what you are about to do and why — then do it immediately.`;
    system += `\n- Never silently retry a cancelled or failed action. If something fails, report it and ask how to proceed.`;
    system += `\n- When debugging, address the root cause — not the symptom. Add logging to track state rather than guessing.`;
    system += `\n- When using a tool, do not narrate it — just use it. Avoid "I will now call..." preamble.`;

    // ── Response style ────────────────────────────────────────────────────────
    system += `\n\nRESPONSE STYLE:`;
    system += `\n- Keep replies short — 1 to 3 sentences where possible. No filler, no preamble, no restating what the user said.`;
    system += `\n- Never start a reply with "Certainly!", "Sure!", "Of course!" or similar affirmations.`;
    system += `\n- Use markdown only when it genuinely helps readability (code blocks, lists). Plain prose otherwise.`;

    // ── Memory rules ─────────────────────────────────────────────────────────
    system += `\n\nMEMORY:`;
    system += `\n- Proactively save important user context (preferences, habits, names, goals, corrections) to memory without being asked.`;
    system += `\n- Do not ask permission before saving a memory — just save it. The user can review and reject saved memories.`;
    system += `\n- If the user corrects you on something, update your memory immediately so the mistake does not repeat.`;

    // ── Skill creation rules ──────────────────────────────────────────────────
    system += `\n\nSKILL CREATION RULES (critical):`;
    system += `\n- ALWAYS use create_skill to create new skills — never write skill files manually.`;
    system += `\n- Never write .ts or .yaml files to the workspace or anywhere else for skills.`;
    system += `\n- create_skill handles generation, TypeScript validation, and installation to ~/.aura/skills/ automatically.`;
    system += `\n- The workspace (~/.aura/workspace/) is for user data only — not for skill drafts or code.`;

    // ── Unloaded skills catalogue ─────────────────────────────────────────────
    // Skills you have but aren't loaded this turn — you're aware of them but
    // can't call their tools until the user's next message triggers them.
    if (unloadedSkillNames && unloadedSkillNames.length > 0 && installedSkills) {
      const unloadedDefs = installedSkills.filter(s => unloadedSkillNames.includes(s.name));
      if (unloadedDefs.length > 0) {
        system += `\n\nYour other installed skills (available but not active this turn — mention them if relevant):`;
        for (const s of unloadedDefs) {
          const desc = s.description.replace(/\n/g, ' ').slice(0, 120);
          system += `\n- ${s.name}: ${desc}`;
        }
      }
    }

    // ── Long-term profiles ────────────────────────────────────────────────────
    // What the agent knows about the user and about itself, learned over time.
    if (userProfile.trim()) {
      system += `\n\n## What I know about the user\n${userProfile.slice(0, 3000)}`;
    }
    if (selfKnowledge.trim()) {
      system += `\n\n## What I know about myself\n${selfKnowledge.slice(0, 2000)}`;
      system += `\n\nIMPORTANT: The tool list above is the authoritative source of your capabilities. ` +
                `If any self-knowledge entry contradicts an available tool, the tool list wins. ` +
                `Never refuse to use a tool that is present in your tool list based on a memory entry.`;
    }

    // ── Message history ───────────────────────────────────────────────────────
    // Token budget: keep only last MAX_MESSAGES turns
    let messages = shortTerm.slice(-MAX_MESSAGES);

    // Append current utterance as user message if not already in history
    const payload = event.payload as Record<string, unknown>;
    if (payload?.text && typeof payload.text === 'string') {
      const lastMsg = messages[messages.length - 1];
      const alreadyAdded = lastMsg?.role === 'user' && lastMsg?.content === payload.text;
      if (!alreadyAdded) {
        const userMsg: LLMMessage = { role: 'user', content: payload.text };
        // Pass image data through so vision-capable adapters can use it
        if (payload.image_b64 && typeof payload.image_b64 === 'string') {
          userMsg.image_b64 = payload.image_b64;
        }
        messages = [...messages, userMsg];
      }
    }

    // ── Volatile context injection ────────────────────────────────────────────
    // Current time and semantic memory hits are injected into the first user
    // message rather than the system prompt. This keeps the system prompt
    // byte-identical across turns so Claude's prompt cache can be reused.
    const now = new Date().toISOString();
    const volatileParts: string[] = [`[Context: Current time: ${now}]`];
    if (semanticHits.length > 0) {
      const capped = semanticHits.slice(0, 5).map(h => h.slice(0, 400));
      volatileParts.push(`[Relevant memory:\n${capped.join('\n')}]`);
    }
    const volatilePrefix = volatileParts.join('\n') + '\n\n';

    // Prepend to the last (current) user message — not the oldest one in history
    const lastUserIdx = messages.reduceRight((found, m, i) => found === -1 && m.role === 'user' ? i : found, -1);
    if (lastUserIdx !== -1 && typeof messages[lastUserIdx].content === 'string') {
      messages = [
        ...messages.slice(0, lastUserIdx),
        { ...messages[lastUserIdx], content: volatilePrefix + messages[lastUserIdx].content },
        ...messages.slice(lastUserIdx + 1),
      ];
    }

    return {
      system,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      max_tokens: 4096,
    };
  }
}
