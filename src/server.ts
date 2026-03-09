import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  loadConfig, loadAgents, AURA_DIR, WORKSPACE_DIR,
} from './config/loader.js';
import { loadNodes } from './config/loader.js';
import { ANPServer, type NodeSessionEntry } from './anp/server.js';
import { LLMRouter } from './llm/router.js';
import { ContextBuilder } from './llm/context.js';
import { AgentRegistry, watchAgents } from './agents/registry.js';
import { MemoryManager } from './memory/manager.js';
import { MemoryExtractor } from './memory/extractor.js';
import { SkillsEngine } from './skills/engine.js';
import { createSelfWriteTool } from './skills/self_write.js';
import { AgentOrchestrator } from './agents/orchestrator.js';
import { ChannelManager } from './channels/manager.js';
import { CanvasRenderer } from './canvas/renderer.js';
import { CanvasServer } from './canvas/server.js';
import { RestAPI, type HeartbeatLogEntry, type TokenStats, type TokenCallEntry } from './api/rest.js';
import { SchedulerEngine } from './scheduler/engine.js';
import { HeartbeatRunner } from './scheduler/heartbeat.js';
import { ProactiveTools } from './scheduler/proactive.js';
import { RateLimiter } from './security/rate_limiter.js';
import { audit } from './security/audit.js';
import { scanSecrets } from './security/secret_scanner.js';
import { RetryQueue } from './retry_queue.js';

import type { ToolDefinition } from './llm/types.js';

// ── Core skills always loaded regardless of message content ──────────────────
const CORE_SKILLS = new Set([
  'web_search', 'self_config', 'reminders', 'filesystem', 'telegram_send',
]);

// ── Session-level skill cache ─────────────────────────────────────────────────
// Tracks which skill groups are active per session. Skills accumulate during a
// conversation and are never dropped mid-session. Sessions expire after 2 hours
// of inactivity to prevent unbounded memory growth.
const SESSION_SKILL_TTL_MS        = 2  * 60 * 60 * 1000; // 2 hours  (webchat, realtime)
const SESSION_SKILL_TTL_STABLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (telegram, stable sessions)
const MAX_SKILL_SESSIONS   = 500;

interface SessionSkillEntry {
  skills:    Set<string>;
  lastUsed:  number;
}

const sessionSkillCache = new Map<string, SessionSkillEntry>();

function getSessionSkills(sessionId: string): Set<string> {
  const entry = sessionSkillCache.get(sessionId);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.skills;
  }
  const fresh: SessionSkillEntry = { skills: new Set(), lastUsed: Date.now() };
  // Evict oldest entry if at cap
  if (sessionSkillCache.size >= MAX_SKILL_SESSIONS) {
    let oldestKey = '';
    let oldestTs  = Infinity;
    for (const [k, v] of sessionSkillCache) {
      if (v.lastUsed < oldestTs) { oldestTs = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) sessionSkillCache.delete(oldestKey);
  }
  sessionSkillCache.set(sessionId, fresh);
  return fresh.skills;
}

function isStableSession(sessionId: string): boolean {
  // Stable sessions have a fixed prefix (telegram_<id>, slack_<id>, discord_<id>, etc.)
  // Webchat/realtime sessions use UUID (8-4-4-4-12 hex format)
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId);
}

function purgeExpiredSessionSkills(): void {
  const now = Date.now();
  for (const [k, v] of sessionSkillCache) {
    const ttl = isStableSession(k) ? SESSION_SKILL_TTL_STABLE_MS : SESSION_SKILL_TTL_MS;
    if (now - v.lastUsed > ttl) sessionSkillCache.delete(k);
  }
}

/**
 * Smart skill loader — loads core + self-written skills always,
 * vector-matched skills for this message, AND any skills already active
 * in this session (so skills accumulate and never drop mid-conversation).
 */
async function smartLoadSkills(
  agentSkills:  string[],
  message:      string,
  sessionId:    string,
  skillsEngine: SkillsEngine,
  mem:          import('./memory/manager.js').MemoryManager,
): Promise<{ toolDefs: ToolDefinition[]; unloadedSkillNames: string[] }> {
  const agentSkillSet = new Set(agentSkills);
  const toLoad        = new Set<string>();
  const sessionSkills = getSessionSkills(sessionId);

  // 1. Always load core skills
  for (const s of CORE_SKILLS) {
    if (agentSkillSet.has(s)) toLoad.add(s);
  }

  // 2. Always load self-written skills
  for (const def of skillsEngine.listSkills()) {
    if (agentSkillSet.has(def.name) && def.source === 'self_written') {
      toLoad.add(def.name);
    }
  }

  // 3a. Instrument override — financial tickers/pairs that vector search misses on short queries.
  // Leading \b only — matches xau/xausd/xauusd etc. (no trailing boundary so prefixes work)
  const FOREX_PATTERN = /\b(xau|xag|xpt|xpd|eur|gbp|jpy|aud|cad|chf|nzd|forex|oanda|gold|silver|pip\b|spread\b|currency\b)/i;
  const STOCK_PATTERN = /\b(stock|equity|share|nasdaq|nyse|alpaca|crypto|bitcoin|btc|eth|ticker)\b/i;
  const forexHit = FOREX_PATTERN.test(message);
  const stockHit = STOCK_PATTERN.test(message);
  if (forexHit) {
    ['forex', 'trading', 'forex_monitor', 'forex_journal'].forEach(s => { if (agentSkillSet.has(s)) toLoad.add(s); });
  }
  if (stockHit) {
    ['trading'].forEach(s => { if (agentSkillSet.has(s)) toLoad.add(s); });
  }
  console.log(`[Skills] Instrument override — forex:${forexHit} stock:${stockHit}`);

  // 3b. Vector-match remaining skills for everything else.
  const FILLER = /\b(fetch|fetching|get|getting|check|show|find|search|look up|tell me|what is|what's|what are|can you|please|give me|for me|try)\b/gi;
  const queryForSkills = message.replace(FILLER, '').replace(/\s+/g, ' ').trim() || message;
  const matched = await mem.searchSkills(queryForSkills).catch(() => [] as string[]);
  console.log(`[Skills] Vector matched: [${matched.join(', ')}] for: "${queryForSkills.slice(0, 60)}"`);
  for (const s of matched) {
    if (agentSkillSet.has(s)) toLoad.add(s);
  }

  // 4. Re-add any skills already active in this session (accumulate, never drop)
  for (const s of sessionSkills) {
    if (agentSkillSet.has(s)) toLoad.add(s);
  }

  // 5. Persist newly loaded skills back into the session cache
  for (const s of toLoad) sessionSkills.add(s);

  const unloadedSkillNames = agentSkills.filter(s => !toLoad.has(s));
  console.log(`[Skills] Loaded: [${[...toLoad].join(', ')}]`);

  return {
    toolDefs:           skillsEngine.getToolDefs([...toLoad]),
    unloadedSkillNames,
  };
}

import type { ANPEvent, UtterancePayload } from './anp/types.js';
import type { LLMMessage, ToolCall } from './llm/types.js';
import type { SkillContext } from './skills/types.js';
import type { CanvasBlock } from './canvas/types.js';
import type { SelfWriteArgs } from './skills/self_write.js';

const MAX_TOOL_ITERATIONS = 25;
// Cap tool results stored in the message history to prevent large responses
// (file reads, page content, etc.) from ballooning every subsequent LLM call.
const MAX_TOOL_RESULT_CHARS = 4000;
const START_TIME = Date.now();

const tokenStats: TokenStats = { total_input: 0, total_output: 0, calls: [] };

// ── Skills node_modules symlink ───────────────────────────────────────────────
// Skills live in ~/.aura/skills/ which has no node_modules.
// We symlink the gateway's node_modules there so skills can `import 'better-sqlite3'` etc.
function ensureSkillsNodeModules(): void {
  const gatewayDir  = path.dirname(fileURLToPath(import.meta.url));
  const gatewayRoot = path.resolve(gatewayDir, '..'); // src/../ = gateway/
  const gwModules   = path.join(gatewayRoot, 'node_modules');
  const skillsDir   = path.join(os.homedir(), '.aura', 'skills');
  const skillsMods  = path.join(skillsDir, 'node_modules');

  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  // Already a correct symlink → nothing to do
  if (fs.existsSync(skillsMods)) {
    try {
      if (fs.lstatSync(skillsMods).isSymbolicLink() && fs.realpathSync(skillsMods) === fs.realpathSync(gwModules)) return;
      // Wrong target or not a symlink — remove and recreate
      fs.rmSync(skillsMods, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  try {
    fs.symlinkSync(gwModules, skillsMods, 'dir');
    console.log('[Skills] Linked gateway node_modules → ~/.aura/skills/node_modules');
  } catch (err) {
    console.warn('[Skills] Could not symlink node_modules:', err);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const agents = loadAgents();

  // ── Registries & core services ──────────────────────────────────────────
  const agentRegistry = new AgentRegistry();
  agentRegistry.load(agents);

  const memory = new MemoryManager(config);
  await memory.init();

  const llm = new LLMRouter(config);

  // ── Live config reload (no restart needed) ────────────────────────────────
  // Watch ~/.aura/config.yaml — any save reloads LLM routing/model immediately.
  const configPath = path.join(os.homedir(), '.aura', 'config.yaml');
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(configPath, () => {
    // Debounce: editors write files in multiple events; wait 300ms for them to settle
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      try {
        const newConfig = loadConfig();
        llm.reload(newConfig);
      } catch (err) {
        console.error('[Config] Reload failed:', err);
      }
    }, 300);
  });
  console.log(`[Config] Watching ${configPath} for live LLM changes`);

  const rateLimiter = new RateLimiter(20, 60_000);
  // Cleanup stale rate limit buckets and sessions every 10 minutes
  setInterval(() => { rateLimiter.cleanup(); memory.cleanupSessions(); purgeExpiredSessionSkills(); }, 600_000);
  const extractor = new MemoryExtractor(llm, memory);
  const contextBuilder = new ContextBuilder();

  // ── Weekly profile auto-consolidation ────────────────────────────────────
  // Deduplicates and reorganises user_profile.md + self_knowledge.md for each
  // agent namespace. Runs on startup (if overdue) then checks every 24 hours.
  const CONSOLIDATION_FLAG = path.join(AURA_DIR, 'memory', '.last_consolidation');
  const CONSOLIDATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  async function autoConsolidate(): Promise<void> {
    try {
      if (fs.existsSync(CONSOLIDATION_FLAG)) {
        const last = parseInt(fs.readFileSync(CONSOLIDATION_FLAG, 'utf8'), 10);
        if (Date.now() - last < CONSOLIDATION_INTERVAL_MS) return;
      }
      const namespaces = new Set(agents.map(a => a.memory_ns).filter(Boolean));
      for (const ns of namespaces) {
        console.log(`[Memory] Auto-consolidating profiles for: ${ns}`);
        await extractor.consolidate(ns);
      }
      fs.writeFileSync(CONSOLIDATION_FLAG, String(Date.now()), 'utf8');
      console.log('[Memory] Profile consolidation complete');
    } catch (err) {
      console.warn('[Memory] Auto-consolidation error:', err instanceof Error ? err.message : err);
    }
  }

  autoConsolidate().catch(() => {});
  setInterval(() => autoConsolidate().catch(() => {}), 24 * 60 * 60 * 1000);
  // Ensure the agent's sandboxed workspace exists
  if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o755 });

  ensureSkillsNodeModules();
  const skills = new SkillsEngine();
  await skills.load();
  skills.watchSkillsDir();

  // Index skill descriptions for vector-based smart loading.
  // Re-index whenever a skill is added or updated.
  const reindexSkills = (): void => {
    const defs = skills.listSkills().filter(s => s.enabled).map(s => ({ name: s.name, description: s.description }));
    memory.indexSkills(defs).catch(() => {});
  };
  reindexSkills();
  skills.onSkillsChanged(reindexSkills);

  const orchestrator = new AgentOrchestrator(llm, skills, config);

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvasRenderer = new CanvasRenderer();
  const canvasServer = new CanvasServer(canvasRenderer, config);
  if (config.canvas.enabled) await canvasServer.start();

  // ── ANP Server ────────────────────────────────────────────────────────────
  const anpServer = new ANPServer(config);
  await anpServer.start();

  // ── Channel Manager ───────────────────────────────────────────────────────
  // Channel adapters are loaded dynamically — only enabled channels are imported.
  // The webchat hook injects gateway metadata before init() is called.
  const channels = new ChannelManager();
  await channels.init(config, {
    webchat: (adapter) => {
      // Reason: WebChatAdapter.setMeta() must be called before init() to inject
      // canvas port, REST port, and agent name into the served HTML/WS config.
      (adapter as unknown as {
        setMeta(cp: number, rp: number, name: string, addr: string): void
      }).setMeta(
        config.canvas.port           ?? 3001,
        config.security.rest_port    ?? 3002,
        agents[0]?.name              ?? 'AURA',
        config.security.bind_address ?? '127.0.0.1',
      );
    },
  });

  channels.startHealthMonitor();

  // ── Proactive / cross-channel send tools ─────────────────────────────────
  const proactiveTools = new ProactiveTools(channels, agentRegistry);

  // ── Self-write tool ───────────────────────────────────────────────────────
  const selfWriteTool = createSelfWriteTool((params) => llm.complete('complex', params));

  // Canvas tool definitions
  const canvasToolDefs = [
    {
      name: 'canvas_clear',
      description: 'Clear all blocks from the live canvas.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'canvas_append',
      description: 'Append a block to the live canvas.',
      parameters: {
        type: 'object',
        properties: {
          type:    { type: 'string', description: 'Block type: text|code|table|image|chart|embed' },
          content: { type: 'string', description: 'Text or code content (for text/code blocks)' },
          language: { type: 'string', description: 'Language for code blocks' },
        },
        required: ['type'],
      },
    },
    {
      name: 'canvas_update',
      description: 'Update an existing canvas block by id.',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'Block id to update' },
          content: { type: 'string', description: 'New content' },
        },
        required: ['id'],
      },
    },
    {
      name: 'canvas_delete',
      description: 'Delete a canvas block by id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Block id to delete' },
        },
        required: ['id'],
      },
    },
  ];

  // Memory tool definitions — allow the agent to explicitly save facts
  const memoryToolDefs = [
    {
      name: 'remember_about_user',
      description: 'Save a specific fact or note about the user to long-term memory. Use this when the user tells you something worth remembering permanently.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact to remember about the user' },
        },
        required: ['fact'],
      },
    },
    {
      name: 'remember_about_self',
      description: 'Save something you learned about yourself — a correction, a preference the user expressed, or a lesson from this conversation.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The self-knowledge note to save' },
        },
        required: ['note'],
      },
    },
    {
      name: 'consolidate_memory',
      description: 'Deduplicate and reorganise the long-term memory profiles, merging redundant facts.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'search_memory',
      description: 'Search past conversations using a custom query. Use this when the user asks about something discussed before and the automatic context did not surface it.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The topic or phrase to search for in past conversations' },
        },
        required: ['query'],
      },
    },
  ];

  // ── Agent config hot-reload ───────────────────────────────────────────────
  const agentsPath = path.join(AURA_DIR, 'agents.yaml');
  watchAgents(agentRegistry, agentsPath, loadAgents);

  // ── Core event loop ───────────────────────────────────────────────────────
  // RetryQueue wraps processEventInner: on transient failure (LLM timeout,
  // network hiccup) the event is retried up to 3 times (1s / 5s / 30s).
  // Rate-limited events are NOT retried — they're rejected immediately.
  const eventQueue = new RetryQueue<ANPEvent>(async (event) => {
    channels.sendTyping(event.node_id).catch(() => {});
    const typingInterval = setInterval(() => {
      channels.sendTyping(event.node_id).catch(() => {});
    }, 4_000);
    try {
      await processEventInner(event);
    } finally {
      clearInterval(typingInterval);
    }
  });

  async function processEvent(event: ANPEvent): Promise<void> {
    const waitSecs = rateLimiter.consume(event.node_id);
    if (waitSecs > 0) {
      audit.rateLimited(event.node_id, waitSecs);
      await sendReply(event.node_id, `⏳ Rate limit reached — please wait ${waitSecs}s before sending another message.`, null);
      return;
    }
    eventQueue.enqueue(event.node_id, event);
  }

  async function processEventInner(event: ANPEvent): Promise<void> {
    const payload = event.payload as UtterancePayload;
    if (!payload?.text) return;

    // If non-image attachments are present, prepend a brief description so the LLM is aware.
    if (payload.attachments && payload.attachments.length > 0) {
      const desc = payload.attachments
        .map(a => `[${a.type}${a.filename ? ': ' + a.filename : ''}${a.mime_type ? ' (' + a.mime_type + ')' : ''}]`)
        .join(', ');
      payload.text = `${desc}\n${payload.text}`;
    }

    const agent   = agentRegistry.resolve(event.node_id);
    const tier    = payload.image_b64
      ? (payload.routing_hint === 'local_vision' ? 'local_vision' : 'vision')
      : agent.llm_tier;

    const shortTerm    = memory.getShortTerm(event.session_id);
    const semanticHits = await memory.search(agent.memory_ns, payload.text).catch(() => []);
    const userProfile  = memory.readProfile(agent.memory_ns);
    const selfKnowledge = memory.readSelf(agent.memory_ns);

    const { toolDefs: skillToolDefs, unloadedSkillNames } = await smartLoadSkills(
      agent.skills ?? [],
      payload.text ?? '',
      event.session_id,
      skills,
      memory,
    );
    const rawTools         = [
      ...skillToolDefs,
      selfWriteTool.toolDef,
      orchestrator.getToolDef(),
      ...canvasToolDefs,
      ...memoryToolDefs,
      ...proactiveTools.getToolDefs(),
    ];
    // Deduplicate by name — first definition wins (Claude rejects duplicate tool names)
    const seen = new Set<string>();
    const allTools = rawTools.filter(t => {
      if (seen.has(t.name)) { console.warn(`[Tools] Duplicate tool name skipped: ${t.name}`); return false; }
      seen.add(t.name); return true;
    });

    const ctx = buildSkillContext(event, agent.memory_ns);

    const installedSkills = skills.listSkills()
      .filter(s => s.enabled)
      .map(s => ({ name: s.name, description: s.description }));

    const params = await contextBuilder.build({
      event, agent, shortTerm, semanticHits,
      toolDefs: allTools, config,
      userProfile, selfKnowledge,
      installedSkills,
      unloadedSkillNames,
    });

    let messages: LLMMessage[] = params.messages;
    let iterations = 0;
    const toolErrors: Array<{ tool: string; error: string }> = [];

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      audit.llmCall(event.node_id, agent.memory_ns, tier, tier);
      let response;
      try {
        response = await llm.complete(tier, {
          system:     params.system,
          messages,
          tools:      params.tools,
          max_tokens: params.max_tokens,
        });
      } catch (err) {
        console.error('[Loop] LLM error:', err);
        await sendReply(event.node_id, `Sorry, I encountered an error. Please try again.`, agent.voice_id);
        return;
      }

      // Accumulate token usage
      tokenStats.total_input  += response.usage.input_tokens;
      tokenStats.total_output += response.usage.output_tokens;
      tokenStats.calls.unshift({
        ts:           Date.now(),
        node_id:      event.node_id,
        tier,
        model:        response.model,
        input_tokens: response.usage.input_tokens,
        output_tokens:response.usage.output_tokens,
      } satisfies TokenCallEntry);
      if (tokenStats.calls.length > 200) tokenStats.calls.length = 200;

      if (!response.tool_calls || response.tool_calls.length === 0) {
        // Final text response
        memory.addTurn(event.session_id, agent.memory_ns, 'user', payload.text);
        memory.addTurn(event.session_id, agent.memory_ns, 'assistant', response.text);
        const { text: safeText, count } = scanSecrets(response.text);
        if (count > 0) audit.secretRedacted(event.node_id, count);
        await sendReply(event.node_id, safeText, agent.voice_id);
        // Log tool errors to self-knowledge (no LLM call needed — errors are already factual)
        if (toolErrors.length > 0) extractor.learnFromErrors(agent.memory_ns, toolErrors);

        // Episodic daily log + vector index
        const today        = new Date().toISOString().slice(0, 10);
        const timeStr      = new Date().toTimeString().slice(0, 5);
        const userExcerpt  = payload.text.slice(0, 120).replace(/\n/g, ' ');
        const replyExcerpt = response.text.slice(0, 250).replace(/\n/g, ' ');
        const episodicLine = `[${today} ${timeStr}] User: ${userExcerpt} → Gary: ${replyExcerpt}`;
        memory.appendEpisodic(agent.memory_ns, today, episodicLine);
        memory.indexMemory(agent.memory_ns, today, episodicLine).catch(() => {});
        return;
      }

      // Append assistant message including tool_calls so Ollama has proper context
      messages = [...messages, {
        role:       'assistant' as const,
        content:    response.text || '',
        tool_calls: response.tool_calls,
      }];

      // Execute all tool calls in this iteration
      for (const call of response.tool_calls) {
        if (!call.name) continue; // skip malformed empty-name tool calls from some models
        let result: unknown;
        audit.toolCall(event.node_id, agent.memory_ns, call.name, JSON.stringify(call.args).slice(0, 200));
        const t0 = Date.now();
        try {
          result = await executeToolCall(call, ctx, event.session_id);
          audit.toolResult(event.node_id, call.name, true, Date.now() - t0);
        } catch (err) {
          audit.toolResult(event.node_id, call.name, false, Date.now() - t0);
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Loop] tool_call ${call.name} FAILED:`, errMsg);
          toolErrors.push({ tool: call.name, error: errMsg });
          result = `Error: ${errMsg}`;
        }
        const raw = JSON.stringify(result);
        const toolContent = raw.length > MAX_TOOL_RESULT_CHARS
          ? raw.slice(0, MAX_TOOL_RESULT_CHARS) + `...[truncated — ${raw.length} total chars]`
          : raw;
        messages = [
          ...messages,
          { role: 'tool', content: toolContent, tool_call_id: call.id },
        ];
      }
    }

    console.warn(`[Loop] Max iterations (${MAX_TOOL_ITERATIONS}) reached for node: ${event.node_id}`);
    const lastToolName = messages.findLast(m => m.role === 'assistant' && m.tool_calls?.length)
      ?.tool_calls?.at(-1)?.name ?? 'unknown';
    await sendReply(
      event.node_id,
      `I got stuck trying to complete that — I ran out of steps while using "${lastToolName}". ` +
      `Could you clarify what you need or break it into smaller steps? I'll try again.`,
      null,
    );
  }

  function buildSkillContext(event: ANPEvent, memory_ns: string): SkillContext {
    return {
      node_id:    event.node_id,
      session_id: event.session_id,
      agent_id:   memory_ns,
      anp:        { sendCommand: (nid, cmd, pl) => anpServer.sendCommand(nid, cmd, pl) },
      memory:     { search: (q) => memory.search(memory_ns, q) },
      channel:    { send: (nid, txt) => channels.send(nid, txt) },
      canvas:     {
        append: (block) => {
          const b = canvasRenderer.append(block as Omit<CanvasBlock, 'id'>);
          canvasServer.broadcast({ event: 'append', block: b });
        },
        clear: () => {
          canvasRenderer.clear();
          canvasServer.broadcast({ event: 'clear' });
        },
      },
    };
  }

  async function executeToolCall(
    call: ToolCall,
    ctx: SkillContext,
    _session_id: string,
  ): Promise<unknown> {
    console.log(`[Loop] tool_call: ${call.name}`);
    const args = call.args as Record<string, unknown>;

    // Self-write tool
    if (call.name === 'create_skill') {
      const result = await selfWriteTool.execute(args as unknown as SelfWriteArgs, ctx);
      reindexSkills();
      return result;
    }

    // Spawn team tool
    if (call.name === 'spawn_team') {
      return orchestrator.spawnTeam(args, ctx.node_id, ctx);
    }

    // Memory tools
    if (call.name === 'remember_about_user') {
      memory.appendToProfile(ctx.agent_id, `- ${String(args['fact'] ?? '')}`);
      return 'Saved to user profile.';
    }
    if (call.name === 'remember_about_self') {
      memory.appendToSelf(ctx.agent_id, `- ${String(args['note'] ?? '')}`);
      return 'Saved to self-knowledge.';
    }
    if (call.name === 'consolidate_memory') {
      await extractor.consolidate(ctx.agent_id);
      return 'Memory profiles consolidated and deduplicated.';
    }
    if (call.name === 'search_memory') {
      const query = String(args['query'] ?? '');
      const hits  = await memory.search(ctx.agent_id, query);
      if (hits.length === 0) return { results: [], message: 'No relevant memories found.' };
      return { results: hits.slice(0, 5).map(h => h.slice(0, 400)) };
    }

    // Canvas tools
    if (call.name === 'canvas_clear') {
      canvasRenderer.clear();
      canvasServer.broadcast({ event: 'clear' });
      return 'Canvas cleared';
    }
    if (call.name === 'canvas_append') {
      const block = canvasRenderer.append(args as Omit<CanvasBlock, 'id'>);
      canvasServer.broadcast({ event: 'append', block });
      return { id: block.id };
    }
    if (call.name === 'canvas_update') {
      const id = String(args['id'] ?? '');
      canvasRenderer.update(id, args as Partial<CanvasBlock>);
      const updated = canvasRenderer.getBlocks().find(b => b.id === id);
      if (updated) canvasServer.broadcast({ event: 'update', id, block: updated });
      return 'Updated';
    }
    if (call.name === 'canvas_delete') {
      const id = String(args['id'] ?? '');
      canvasRenderer.delete(id);
      canvasServer.broadcast({ event: 'delete', id });
      return 'Deleted';
    }

    // Cross-channel / proactive send tools
    if (call.name === 'send_message') {
      return proactiveTools.send_message(args as { node_id: string; text: string });
    }
    if (call.name === 'send_to_agent_channels') {
      return proactiveTools.send_to_agent_channels(args as { agent_id: string; text: string });
    }

    // Skill tools
    return skills.execute(call.name, args, ctx);
  }

  async function sendReply(
    node_id: string,
    text: string | undefined,
    voice_id: string | null | undefined,
    attachments?: import('./channels/interface.js').MediaAttachment[],
  ): Promise<void> {
    // Hardware ANP node → speak command (no media support on ANP nodes)
    if (anpServer.isConnected(node_id)) {
      anpServer.sendCommand(node_id, 'speak', {
        text: text ?? '',
        voice: voice_id ?? undefined,
        display: text ?? '',
      });
      return;
    }
    // Channel node → send via channel adapter
    await channels.send(node_id, text, attachments);
  }

  // Wire ANP utterance events
  anpServer.on('utterance', (event: ANPEvent, _session: NodeSessionEntry) => {
    processEvent(event).catch(err => console.error('[Loop] processEvent error:', err));
  });

  // Wire channel utterance events
  channels.onMessage((event: ANPEvent) => {
    processEvent(event).catch(err => console.error('[Loop] channel event error:', err));
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeatRunner = new HeartbeatRunner(llm, agentRegistry, memory, skills, channels);
  const heartbeatLog: HeartbeatLogEntry[] = [];

  async function triggerHeartbeat(): Promise<void> {
    const start = Date.now();
    const entry = await heartbeatRunner.run();
    heartbeatLog.unshift({
      ts: entry.ts,
      result: entry.result,
      duration_ms: Date.now() - start,
    });
    if (heartbeatLog.length > 50) heartbeatLog.length = 50;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────
  const wfSkillCtx = {
    node_id: 'scheduler', session_id: 'scheduler', agent_id: 'scheduler',
    anp:    { sendCommand: () => {} },
    memory: { search: async () => [] },
    channel:{ send: async () => {} },
    canvas: { append: () => {}, clear: () => {} },
  };
  const workflowFireFn = async (name: string): Promise<void> => {
    await skills.execute('workflow_run', { name, payload: {}, async: true }, wfSkillCtx);
  };
  const scheduler = new SchedulerEngine(config, memory, channels, triggerHeartbeat, workflowFireFn);
  scheduler.start();

  // ── REST API ───────────────────────────────────────────────────────────────
  const restApi = new RestAPI({
    config, anpServer, agentRegistry,
    skillsEngine: skills, memoryManager: memory,
    canvasRenderer, triggerHeartbeat,
    heartbeatLog, startTime: START_TIME,
    orchestrator, tokenStats,
  });
  await restApi.start();

  console.log('\n✅ AURA Gateway started');
  console.log(`   ANP WebSocket : ws://${config.security.bind_address}:${config.security.anp_port}/anp`);
  console.log(`   REST API      : http://${config.security.bind_address}:${config.security.rest_port}`);
  if (config.canvas.enabled)
    console.log(`   Canvas WS     : ws://${config.security.bind_address}:${config.canvas.port}/canvas`);
  console.log(`   Agents loaded : ${agents.length}`);
  console.log(`   Skills loaded : ${skills.listSkills().length}`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Gateway] Received ${signal}, shutting down...`);
    scheduler.stop();
    await restApi.stop();
    await canvasServer.stop();
    await channels.destroy();
    await anpServer.stop();
    console.log('[Gateway] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT',  () => { shutdown('SIGINT').catch(console.error); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(console.error); });
}

main().catch((err) => {
  console.error('[Gateway] Fatal startup error:', err);
  process.exit(1);
});
