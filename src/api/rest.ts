import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import fs from 'fs';
import nodePath from 'path';
import os from 'os';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import type { GatewayConfig } from '../config/loader.js';
import type { ANPServer } from '../anp/server.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { SkillsEngine } from '../skills/engine.js';
import type { MemoryManager } from '../memory/manager.js';
import type { CanvasRenderer } from '../canvas/renderer.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { AnthropicProxy } from '../llm/anthropic_proxy.js';

export interface HeartbeatLogEntry {
  ts:          number;
  result:      string;
  duration_ms: number;
}

export interface TokenCallEntry {
  ts:           number;
  node_id:      string;
  tier:         string;
  model:        string;
  input_tokens: number;
  output_tokens:number;
}

export interface TokenStats {
  total_input:  number;
  total_output: number;
  calls:        TokenCallEntry[];
}

// In-memory workflow state store for dashboard2
const workflowUpdates = new Map<string, { workflow_id: string; status: string; data: unknown; timestamp: string }>();
const workflowEvents: Array<{ workflow_id: string; status: string; data: unknown; timestamp: string }> = [];

// ── Dashboard4: Agent Teams — in-memory event store ──────────────────────────
const team4Events = new Map<string, Array<{ type: string; data: unknown; ts: number }>>();
const MAX_TEAM_EVENTS = 300;

function team4Push(sessionId: string, type: string, data: unknown, ts: number): void {
  const evts = team4Events.get(sessionId) ?? [];
  evts.push({ type, data, ts });
  if (evts.length > MAX_TEAM_EVENTS) evts.splice(0, evts.length - MAX_TEAM_EVENTS);
  team4Events.set(sessionId, evts);
}

// ── Dashboard3: Workflow Automation v2 — in-memory live event store ──────────
const wf3Events: Array<{ execution_id: string; workflow_name: string; status: string; data: unknown; timestamp: string }> = [];
const WORKFLOWS_DIR = nodePath.join(os.homedir(), '.aura', 'workflows');
const WF_DB_PATH    = nodePath.join(os.homedir(), '.aura', 'memory', 'aura.db');

function wf3Db() {
  if (!fs.existsSync(nodePath.dirname(WF_DB_PATH))) return null;
  try {
    const d = new Database(WF_DB_PATH);
    return d;
  } catch { return null; }
}

const WF3_TEMPLATES = [
  {
    id: 'webhook_notify', name: 'Webhook → Notify',
    description: 'Receive a webhook and forward a message to another endpoint',
    definition: {
      name: 'webhook-notify', description: 'Forward an incoming webhook to a notification endpoint',
      trigger: { type: 'webhook', webhook_key: 'my-alerts' },
      steps: [
        { id: 'log_received', type: 'log', message: 'Webhook received: {{payload.event}}', on_success: 'notify' },
        { id: 'notify', type: 'webhook', url: 'https://hooks.example.com/notify', payload: { text: 'Alert: {{payload.event}} — {{payload.message}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Done.' },
      ],
    },
  },
  {
    id: 'condition_branch', name: 'Condition → Branch',
    description: 'Check a value and take different actions based on the result',
    definition: {
      name: 'condition-branch', description: 'Branch on a payload value',
      trigger: { type: 'manual' },
      steps: [
        { id: 'check', type: 'condition', condition: { field: 'payload.value', operator: 'gt', value: 100 }, on_true: 'high_action', on_false: 'low_action' },
        { id: 'high_action', type: 'log', message: 'Value is HIGH: {{payload.value}}', on_success: 'end' },
        { id: 'low_action', type: 'log', message: 'Value is LOW: {{payload.value}}', on_success: 'end' },
        { id: 'end', type: 'log', message: 'Branch complete.' },
      ],
    },
  },
  {
    id: 'retry_webhook', name: 'Webhook with Retry',
    description: 'Send a webhook and retry up to 3 times on failure',
    definition: {
      name: 'retry-webhook', description: 'Reliable webhook delivery with retry',
      trigger: { type: 'manual' },
      steps: [
        { id: 'send', type: 'webhook', url: '{{payload.url}}', payload: { data: '{{payload.data}}' }, retry: { max_attempts: 3, delay_ms: 2000 }, on_success: 'done', on_failure: 'fail_log' },
        { id: 'done', type: 'log', message: 'Delivered successfully.' },
        { id: 'fail_log', type: 'log', message: 'Failed after 3 attempts: {{steps.send.output.error}}' },
      ],
    },
  },
  {
    id: 'multi_step', name: 'Multi-Step Pipeline',
    description: 'Fetch data, transform it, wait, then send results',
    definition: {
      name: 'multi-step-pipeline', description: 'Fetch → transform → wait → deliver',
      trigger: { type: 'manual' },
      steps: [
        { id: 'fetch', type: 'webhook', method: 'GET', url: '{{payload.source_url}}', payload: {}, on_success: 'transform' },
        { id: 'transform', type: 'transform', mappings: { summary: '{{steps.fetch.output.body}}', source: '{{payload.source_url}}' }, on_success: 'wait' },
        { id: 'wait', type: 'wait', duration_ms: 2000, on_success: 'deliver' },
        { id: 'deliver', type: 'webhook', url: '{{payload.dest_url}}', payload: { summary: '{{steps.transform.output.summary}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Pipeline complete. Delivered to {{payload.dest_url}}' },
      ],
    },
  },
  {
    id: 'scheduled_report', name: 'Scheduled Report',
    description: 'Collect data and send a daily report on a schedule',
    definition: {
      name: 'scheduled-report', description: 'Daily report via webhook',
      trigger: { type: 'schedule', schedule: '0 9 * * 1-5' },
      steps: [
        { id: 'collect', type: 'skill', skill_name: 'web_search', tool_name: 'search', params: { query: 'daily summary {{env.workflow}}' }, on_success: 'format', on_failure: 'fail' },
        { id: 'format', type: 'transform', mappings: { report: '{{steps.collect.output}}', generated_at: '{{env.started_at}}' }, on_success: 'send' },
        { id: 'send', type: 'webhook', url: '{{payload.report_url}}', payload: { report: '{{steps.format.output.report}}', at: '{{steps.format.output.generated_at}}' }, on_success: 'end' },
        { id: 'end', type: 'log', message: 'Report sent.' },
        { id: 'fail', type: 'log', message: 'Report collection failed: {{steps.collect.output.error}}' },
      ],
    },
  },
];

// Saved workflow configurations
const savedWorkflows: Array<{ id: string; name: string; steps: WorkflowStep[]; created: string }> = [];

interface WorkflowStep {
  operation: string;
  params: Record<string, string>;
}

const EC2_SIM: Record<string, (p: Record<string, string>) => string> = {
  describe_instances:  p => `Found i-0${Math.random().toString(36).slice(2,9)}, i-0${Math.random().toString(36).slice(2,9)} in ${p['region'] ?? 'us-east-1'}`,
  start_instances:     p => `Started ${p['instance_ids'] ?? 'instances'} — state: pending`,
  stop_instances:      p => `Stopped ${p['instance_ids'] ?? 'instances'} — state: stopping`,
  reboot_instances:    p => `Rebooted ${p['instance_ids'] ?? 'instances'} successfully`,
  create_snapshot:     p => `snap-${Math.random().toString(36).slice(2,10)} created for ${p['instance_id'] ?? 'i-0abc1234'}`,
  scale_asg:           p => `ASG '${p['asg_name'] ?? 'my-asg'}' scaling to ${p['desired_capacity'] ?? '3'} instances`,
  deploy_application:  p => `Deployed ${p['app_name'] ?? 'app'} v${p['version'] ?? '1.0'} → ${p['environment'] ?? 'production'}`,
  check_health:        p => `Health OK — ${p['instance_ids'] ?? 'instances'}: system=ok, instance=ok`,
  run_ssm_command:     p => `SSM cmd-${Math.random().toString(36).slice(2,10)} queued on ${p['instance_ids'] ?? 'instances'}`,
};

async function runWorkflowSimulation(workflowId: string, name: string, steps: WorkflowStep[]): Promise<void> {
  const post = (status: string, idx: number, extra: Record<string, unknown> = {}): void => {
    const entry = {
      workflow_id: workflowId,
      status,
      data: { step: steps[idx]?.operation ?? 'done', step_index: idx, total_steps: steps.length, workflow_name: name, ...extra },
      timestamp: new Date().toISOString(),
    };
    workflowUpdates.set(workflowId, entry);
    workflowEvents.push(entry);
    if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
  };

  post('running', 0);
  for (let i = 0; i < steps.length; i++) {
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 1300));
    const simFn = EC2_SIM[steps[i]!.operation] ?? (() => 'Operation completed');
    const result = simFn(steps[i]!.params);
    if (i < steps.length - 1) {
      post('running', i + 1, { last_result: result });
    } else {
      const entry = {
        workflow_id: workflowId,
        status: 'completed',
        data: { step: 'completed', step_index: i, total_steps: steps.length, workflow_name: name, last_result: result },
        timestamp: new Date().toISOString(),
      };
      workflowUpdates.set(workflowId, entry);
      workflowEvents.push(entry);
      if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
    }
  }
}

export interface RestAPIParams {
  config:           GatewayConfig;
  anpServer:        ANPServer;
  agentRegistry:    AgentRegistry;
  skillsEngine:     SkillsEngine;
  memoryManager:    MemoryManager;
  canvasRenderer:   CanvasRenderer;
  triggerHeartbeat: () => Promise<void>;
  heartbeatLog:     HeartbeatLogEntry[];
  startTime:        number;
  orchestrator:     AgentOrchestrator;
  tokenStats:       TokenStats;
  getPulseStatus:   () => import('../scheduler/pulse.js').PulseStatus;
  anthropicProxy:   AnthropicProxy;
}

const VERSION = '1.0.0';

/**
 * HTTP REST API server on port 3002.
 * All endpoints bound to 127.0.0.1 only.
 */
// ── Browser Extension WebSocket registry ──────────────────────────────────────
export const extensionClients  = new Map<string, WebSocket>();
export const extensionPending  = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export class RestAPI {
  private server: ReturnType<typeof createServer>;
  private params: RestAPIParams;
  private wss:    WebSocketServer;

  constructor(params: RestAPIParams) {
    this.params = params;
    this.server = createServer((req, res) => this.handle(req, res));
    this.wss    = new WebSocketServer({ noServer: true });
  }

  async start(): Promise<void> {
    const { bind_address, rest_port } = this.params.config.security;

    // WebSocket upgrade for browser extension at ws://host:3002/webextension
    this.server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/webextension') { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const clientId = Date.now().toString(36);
        extensionClients.set(clientId, ws);
        console.log(`[Extension] Browser extension connected (id=${clientId})`);
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as { id: string; result: unknown; error?: string };
            const pending = extensionPending.get(msg.id);
            if (pending) {
              extensionPending.delete(msg.id);
              msg.error ? pending.reject(new Error(msg.error)) : pending.resolve(msg.result);
            }
          } catch { /* ignore malformed */ }
        });
        ws.on('close', () => {
          extensionClients.delete(clientId);
          clearInterval(pingInterval);
          // Reject any pending commands for this connection
          for (const [pendingId, p] of extensionPending) {
            if (pendingId.startsWith(clientId.slice(0, 4))) {
              extensionPending.delete(pendingId);
              p.reject(new Error('Extension disconnected'));
            }
          }
          console.log(`[Extension] Browser extension disconnected (id=${clientId})`);
        });
        ws.on('error', (err) => {
          console.warn(`[Extension] WebSocket error (id=${clientId}):`, err.message);
        });

        // Keepalive ping every 20s — prevents Chrome from killing the service worker
        const pingInterval = setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', id: `ping-${Date.now()}` }));
          }
        }, 20_000);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[REST] Port ${rest_port} already in use — is another gateway instance running?`);
          resolve(); // non-fatal: log and continue
        } else {
          reject(err);
        }
      });
      this.server.listen(rest_port, bind_address, () => {
        console.log(`[REST] API listening on http://${bind_address}:${rest_port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // --- Health ---
      // --- Browser Extension ---
      // --- Anthropic-compatible proxy (AURA acts as LLM for Claude Code) ---
      if (method === 'POST' && path === '/proxy/v1/messages') {
        return this.params.anthropicProxy.handle(req, res);
      }

      if (method === 'GET' && path === '/api/extension/status') {
        return this.json(res, 200, { connected: extensionClients.size > 0, clients: extensionClients.size });
      }
      if (method === 'POST' && path === '/api/extension/command') {
        if (extensionClients.size === 0) return this.json(res, 503, { error: 'No browser extension connected' });
        const body = JSON.parse(await this.readBody(req)) as { command: string; [k: string]: unknown };
        const id    = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const [, ws] = [...extensionClients.entries()][0]!;
        try {
          const result = await new Promise<unknown>((resolve, reject) => {
            extensionPending.set(id, { resolve, reject });
            setTimeout(() => { extensionPending.delete(id); reject(new Error('Extension command timeout (10s)')); }, 10_000);
            ws.send(JSON.stringify({ id, ...body }));
          });
          return this.json(res, 200, { success: true, result });
        } catch (extErr) {
          // Extension returned an error (e.g. "Cannot access a chrome:// URL") — return as clean JSON, not 500
          return this.json(res, 200, { success: false, error: extErr instanceof Error ? extErr.message : String(extErr) });
        }
      }

      if (method === 'GET' && path === '/api/health') {
        const nodes = this.params.anpServer.getConnectedNodes();
        return this.json(res, 200, {
          status: 'ok',
          uptime_s: Math.floor((Date.now() - this.params.startTime) / 1000),
          version: VERSION,
          nodes_connected: nodes.size,
          agents_loaded: this.params.agentRegistry.getAll().length,
        });
      }

      // --- Nodes ---
      if (method === 'GET' && path === '/api/nodes') {
        const nodes = Array.from(this.params.anpServer.getConnectedNodes().values()).map(s => ({
          node_id: s.node_id, session_id: s.session_id, caps: s.caps, connected_at: s.connected_at,
        }));
        return this.json(res, 200, nodes);
      }

      if (method === 'POST' && path.match(/^\/api\/nodes\/(.+)\/command$/)) {
        const node_id = path.replace('/api/nodes/', '').replace('/command', '');
        const body = await this.readBody(req);
        const { cmd, payload } = JSON.parse(body) as { cmd: string; payload: unknown };
        this.params.anpServer.sendCommand(node_id, cmd, payload);
        res.writeHead(204); res.end();
        return;
      }

      if (method === 'POST' && path.match(/^\/api\/nodes\/(.+)\/rotate-token$/)) {
        const crypto = await import('crypto');
        const token = 'sk-aura-' + crypto.randomBytes(32).toString('hex');
        return this.json(res, 200, { token });
      }

      // --- Agents ---
      if (method === 'GET' && path === '/api/agents') {
        return this.json(res, 200, this.params.agentRegistry.getAll());
      }

      const memSearchMatch = path.match(/^\/api\/agents\/(.+)\/memory\/search$/);
      if (method === 'GET' && memSearchMatch) {
        const agent_id = memSearchMatch[1];
        const q = url.searchParams.get('q') ?? '';
        const agent = this.params.agentRegistry.get(agent_id ?? '');
        if (!agent) return this.json(res, 404, { error: 'Agent not found' });
        const results = await this.params.memoryManager.search(agent.memory_ns, q);
        return this.json(res, 200, { results });
      }

      const memDateMatch = path.match(/^\/api\/agents\/(.+)\/memory\/(\d{4}-\d{2}-\d{2})$/);
      if (memDateMatch) {
        const [, agent_id, date] = memDateMatch;
        const agent = this.params.agentRegistry.get(agent_id ?? '');
        if (!agent) return this.json(res, 404, { error: 'Agent not found' });
        if (method === 'GET') {
          const content = await this.params.memoryManager.readEpisodic(agent.memory_ns, date ?? '');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(content); return;
        }
        if (method === 'DELETE') {
          await this.params.memoryManager.deleteEpisodic(agent.memory_ns, date ?? '');
          res.writeHead(204); res.end(); return;
        }
      }

      // --- Skills ---
      if (method === 'GET' && path === '/api/skills') {
        return this.json(res, 200, this.params.skillsEngine.listSkills());
      }

      const skillToggleMatch = path.match(/^\/api\/skills\/(.+)\/toggle$/);
      if (method === 'POST' && skillToggleMatch) {
        const name = skillToggleMatch[1];
        const skills = this.params.skillsEngine.listSkills();
        const skill = skills.find(s => s.name === name);
        if (!skill) return this.json(res, 404, { error: 'Skill not found' });
        skill.enabled = !skill.enabled;
        return this.json(res, 200, { enabled: skill.enabled });
      }

      // --- Canvas ---
      if (method === 'GET' && path === '/api/canvas') {
        return this.json(res, 200, this.params.canvasRenderer.getBlocks());
      }
      if (method === 'DELETE' && path === '/api/canvas') {
        this.params.canvasRenderer.clear();
        res.writeHead(204); res.end(); return;
      }

      // --- Heartbeat ---
      if (method === 'POST' && path === '/api/heartbeat/run') {
        this.params.triggerHeartbeat().catch(err => console.error('[Heartbeat] Manual run error:', err));
        return this.json(res, 200, { triggered: true });
      }
      if (method === 'GET' && path === '/api/heartbeat/log') {
        return this.json(res, 200, this.params.heartbeatLog.slice(-50));
      }

      if (method === 'GET' && path === '/api/pulse') {
        return this.json(res, 200, this.params.getPulseStatus());
      }

      // --- Webhooks ---
      const webhookGetMatch = path.match(/^\/api\/webhooks\/(.+)$/);
      if (webhookGetMatch) {
        const key = webhookGetMatch[1];
        if (method === 'GET') {
          const payloads = await this.params.memoryManager.getWebhooks(key ?? '');
          return this.json(res, 200, payloads);
        }
        if (method === 'DELETE') {
          await this.params.memoryManager.deleteWebhooks(key ?? '');
          res.writeHead(204); res.end(); return;
        }
      }

      // --- Inbound webhooks ---
      const inboundMatch = path.match(/^\/webhook\/(.+)$/);
      if (method === 'POST' && inboundMatch) {
        const key = inboundMatch[1] ?? '';
        const body = await this.readBody(req);
        await this.params.memoryManager.storeWebhook(key, body);

        // Fire any workflow_automation_v2 workflows whose trigger.webhook_key matches
        let wfPayload: unknown = {};
        try { wfPayload = JSON.parse(body); } catch { wfPayload = { raw: body }; }
        const wfCtx = {
          node_id: 'webhook', session_id: `wh-${Date.now()}`, agent_id: 'webhook',
          anp:    { sendCommand: () => {} },
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        };
        this.params.skillsEngine.execute('workflow_trigger_webhook', { webhook_key: key, payload: wfPayload } as Record<string, unknown>, wfCtx)
          .catch(err => console.error('[Webhook] workflow trigger error:', err));

        return this.json(res, 200, { received: true, webhook_key: key });
      }

      // --- LLM Config ---
      if (method === 'GET' && path === '/api/llm/config') {
        // Read live from disk so the dashboard reflects changes immediately after a switch
        let cfg = this.params.config;
        try {
          const raw = fs.readFileSync(nodePath.join(os.homedir(), '.aura', 'config.yaml'), 'utf8');
          const parsed = yaml.load(raw) as typeof cfg;
          if (parsed?.llm) cfg = { ...cfg, llm: parsed.llm };
        } catch { /* fall back to in-memory config */ }
        // Always return all four providers with live process.env key status (not cached config)
        const defaultModels: Record<string, string[]> = {
          claude:     ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4'],
          openai:     ['gpt-4o', 'gpt-4o-mini'],
          gemini:     ['gemini-1.5-pro', 'gemini-1.5-flash'],
          mistral:    ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b'],
          openrouter: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.1-70b-instruct'],
          qwen:       ['qwen-max', 'qwen-plus', 'qwen-flash', 'qwq-plus', 'qwen-omni-turbo', 'qwen3-omni-flash'],
        };
        const providers: Record<string, unknown> = {};
        for (const [name, envVar] of [
          ['claude',      'ANTHROPIC_API_KEY'],
          ['openai',      'OPENAI_API_KEY'],
          ['gemini',      'GOOGLE_API_KEY'],
          ['mistral',     'MISTRAL_API_KEY'],
          ['openrouter',  'OPENROUTER_API_KEY'],
          ['qwen',        'DASHSCOPE_API_KEY'],
        ] as [string, string][]) {
          const cfgProv = cfg.llm?.providers?.[name] as { models?: string[] } | undefined;
          providers[name] = {
            api_key_set: !!(process.env[envVar]),
            models: cfgProv?.models ?? defaultModels[name] ?? [],
          };
        }
        const ollamaCfg = cfg.llm?.providers?.['ollama'] as { base_url?: string; models?: string[] } | undefined;
        providers['ollama'] = {
          base_url: ollamaCfg?.base_url ?? 'http://localhost:11434',
          models:   ollamaCfg?.models  ?? [],
        };
        return this.json(res, 200, { routing: cfg.llm?.routing ?? {}, providers });
      }

      if (method === 'POST' && path === '/api/llm/config') {
        const body = await this.readBody(req);
        const { routing, api_key } = JSON.parse(body) as {
          routing?:  Record<string, string>;
          api_key?:  { provider: string; key: string };
        };

        const configPath = nodePath.join(os.homedir(), '.aura', 'config.yaml');
        let rawCfg: Record<string, unknown> = {};
        try {
          if (fs.existsSync(configPath)) {
            rawCfg = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> ?? {};
          }
        } catch { /* start fresh */ }

        if (routing) {
          const llm = (rawCfg['llm'] as Record<string, unknown> | undefined) ?? {};
          const existing = (llm['routing'] as Record<string, string> | undefined) ?? {};
          llm['routing'] = { ...existing, ...routing };
          rawCfg['llm'] = llm;
          fs.writeFileSync(configPath, yaml.dump(rawCfg, { lineWidth: 120 }), 'utf8');
        }

        if (api_key) {
          const ENV_VARS: Record<string, string> = {
            claude: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
          };
          const envVar = ENV_VARS[api_key.provider];
          if (!envVar) return this.json(res, 400, { error: 'Unknown provider' });

          // Write to .env file for persistence
          const envPath = nodePath.join(process.cwd(), '.env');
          let envContent = '';
          try { envContent = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
          const lines = envContent.split('\n').filter(l => !l.startsWith(`${envVar}=`));
          lines.push(`${envVar}=${api_key.key}`);
          fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n', 'utf8');

          // Update live process.env so GET reflects the change immediately (no restart needed to see status)
          process.env[envVar] = api_key.key;
        }

        return this.json(res, 200, { ok: true });
      }

      // --- Orchestrator ---
      if (method === 'GET' && path === '/api/orchestrator/sessions') {
        return this.json(res, 200, this.params.orchestrator.getSessions());
      }

      // --- Token usage ---
      if (method === 'GET' && path === '/api/usage') {
        return this.json(res, 200, this.params.tokenStats);
      }

      // --- Browser screenshots ---
      if (method === 'GET' && path === '/api/browser/screenshots') {
        const screenshotsDir = nodePath.join(os.homedir(), '.aura', 'screenshots');
        if (!fs.existsSync(screenshotsDir)) return this.json(res, 200, []);
        const files = fs.readdirSync(screenshotsDir)
          .filter(f => f.endsWith('.png'))
          .sort((a, b) => {
            const sa = fs.statSync(nodePath.join(screenshotsDir, a));
            const sb = fs.statSync(nodePath.join(screenshotsDir, b));
            return sb.mtimeMs - sa.mtimeMs;
          })
          .slice(0, 50)
          .map(f => ({
            name:     f,
            url:      `/api/browser/screenshots/${f}`,
            size_kb:  Math.round(fs.statSync(nodePath.join(screenshotsDir, f)).size / 1024),
            taken_at: fs.statSync(nodePath.join(screenshotsDir, f)).mtimeMs,
          }));
        return this.json(res, 200, files);
      }

      const screenshotFileMatch = path.match(/^\/api\/browser\/screenshots\/(.+\.png)$/);
      if (method === 'GET' && screenshotFileMatch) {
        const name = screenshotFileMatch[1];
        const filepath = nodePath.join(os.homedir(), '.aura', 'screenshots', name!);
        if (!fs.existsSync(filepath)) return this.json(res, 404, { error: 'Not found' });
        const buf = fs.readFileSync(filepath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
        res.end(buf);
        return;
      }

      // --- Dashboard2: EC2 Workflow UI ---
      if (method === 'GET' && (path === '/dashboard2' || path === '/dashboard2/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard2.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // POST from ec2_workflow_automation skill — receives live workflow updates
      if (method === 'POST' && path === '/dashboard2/api/workflow-update') {
        const body = await this.readBody(req);
        const update = JSON.parse(body) as { workflow_id: string; status: string; data?: unknown; timestamp?: string };
        const entry = { ...update, data: update.data ?? {}, timestamp: update.timestamp ?? new Date().toISOString() };
        workflowUpdates.set(update.workflow_id, entry);
        workflowEvents.push(entry);
        if (workflowEvents.length > 100) workflowEvents.splice(0, workflowEvents.length - 100);
        return this.json(res, 200, { ok: true });
      }

      // GET — frontend polls this for workflow state
      if (method === 'GET' && path === '/dashboard2/api/workflows') {
        const workflows = Array.from(workflowUpdates.values());
        const stats = {
          total:     workflows.length,
          completed: workflows.filter(w => w.status === 'completed').length,
          running:   workflows.filter(w => w.status === 'running').length,
          failed:    workflows.filter(w => w.status === 'failed').length,
        };
        return this.json(res, 200, { workflows, events: workflowEvents, stats });
      }

      // DELETE a workflow card from the board
      const wfDeleteMatch = path.match(/^\/dashboard2\/api\/workflows\/(.+)$/);
      if (method === 'DELETE' && wfDeleteMatch) {
        workflowUpdates.delete(wfDeleteMatch[1]!);
        res.writeHead(204); res.end(); return;
      }

      // GET EC2 workflow templates
      if (method === 'GET' && path === '/dashboard2/api/templates') {
        return this.json(res, 200, [
          { id: 'backup', name: 'Full Backup', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1', filter_state: 'running' } },
            { operation: 'create_snapshot',    params: { instance_id: 'i-0abc1234', description: 'Auto backup' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'rolling_restart', name: 'Rolling Restart', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'stop_instances',     params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'start_instances',    params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'scale_up', name: 'Scale Up', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'scale_asg',          params: { asg_name: 'my-asg', desired_capacity: '5', region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
          { id: 'deploy', name: 'Deploy & Verify', steps: [
            { operation: 'deploy_application', params: { app_name: 'myapp', version: '2.0.0', environment: 'production' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
            { operation: 'run_ssm_command',    params: { instance_ids: 'i-0abc1234', command: 'systemctl status myapp', region: 'us-east-1' } },
          ]},
          { id: 'health_check', name: 'Health Check', steps: [
            { operation: 'describe_instances', params: { region: 'us-east-1' } },
            { operation: 'check_health',       params: { instance_ids: 'i-0abc1234', region: 'us-east-1' } },
          ]},
        ]);
      }

      // GET saved custom workflows
      if (method === 'GET' && path === '/dashboard2/api/saved') {
        return this.json(res, 200, savedWorkflows);
      }

      // POST save a custom workflow config
      if (method === 'POST' && path === '/dashboard2/api/save') {
        const body = await this.readBody(req);
        const wf = JSON.parse(body) as { name: string; steps: WorkflowStep[] };
        const id = `wf-${Date.now().toString(36)}`;
        savedWorkflows.push({ id, name: wf.name, steps: wf.steps, created: new Date().toISOString() });
        return this.json(res, 200, { id });
      }

      // POST run a workflow — starts async simulation
      if (method === 'POST' && path === '/dashboard2/api/run') {
        const body = await this.readBody(req);
        const wf = JSON.parse(body) as { name: string; steps: WorkflowStep[] };
        const workflowId = `${wf.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
        runWorkflowSimulation(workflowId, wf.name, wf.steps).catch(console.error);
        return this.json(res, 200, { workflow_id: workflowId, started: true });
      }

      // --- Dashboard UI ---
      if (method === 'GET' && (path === '/dashboard' || path === '/dashboard/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // ── Generic skill tool executor (used by workflow_automation_v2 skill steps) ──
      // POST /api/skills/:skillName/tools/:toolName  { ...args }
      const skillToolMatch = path.match(/^\/api\/skills\/([^/]+)\/tools\/([^/]+)$/);
      if (method === 'POST' && skillToolMatch) {
        const [, skillName, toolName] = skillToolMatch;
        const body = await this.readBody(req);
        const args = body ? JSON.parse(body) : {};
        const result = await this.params.skillsEngine.execute(toolName!, args as Record<string, unknown>, {
          node_id: 'rest-api', session_id: `rest-${Date.now()}`, agent_id: 'rest',
          anp:    { sendCommand: () => {} },
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // ── Dashboard3: Workflow Automation v2 ───────────────────────────────────

      // Serve HTML
      if (method === 'GET' && (path === '/dashboard3' || path === '/dashboard3/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard3.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Receive live step updates from the skill (fire-and-forget POSTs)
      if (method === 'POST' && path === '/dashboard3/api/workflow-update') {
        const body = await this.readBody(req);
        const update = JSON.parse(body) as { execution_id: string; workflow_name: string; status: string; data?: unknown; timestamp?: string };
        wf3Events.push({ ...update, data: update.data ?? {}, timestamp: update.timestamp ?? new Date().toISOString() });
        if (wf3Events.length > 200) wf3Events.splice(0, wf3Events.length - 200);
        return this.json(res, 200, { ok: true });
      }

      // List executions from SQLite + live events
      if (method === 'GET' && path === '/dashboard3/api/executions') {
        const d = wf3Db();
        let executions: unknown[] = [];
        if (d) {
          executions = d.prepare(`SELECT id, workflow_name, status, trigger_type, started_at, updated_at, completed_at, steps_done, error FROM wf_executions ORDER BY started_at DESC LIMIT 100`).all();
          d.close();
        }
        const stats = {
          total:     (executions as { status: string }[]).length,
          running:   (executions as { status: string }[]).filter(e => e.status === 'running').length,
          completed: (executions as { status: string }[]).filter(e => e.status === 'completed').length,
          failed:    (executions as { status: string }[]).filter(e => e.status === 'failed').length,
        };
        return this.json(res, 200, { executions, events: wf3Events.slice(-100).reverse(), stats });
      }

      // Delete an execution card from the board (marks as archived in-memory only)
      const wf3ExecDeleteMatch = path.match(/^\/dashboard3\/api\/executions\/(.+)$/);
      if (method === 'DELETE' && wf3ExecDeleteMatch) {
        // Remove from live events list
        const id = decodeURIComponent(wf3ExecDeleteMatch[1]!);
        const idx = wf3Events.findIndex(e => e.execution_id === id);
        if (idx !== -1) wf3Events.splice(idx, 1);
        res.writeHead(204); res.end(); return;
      }

      // List workflow definitions from ~/.aura/workflows/
      if (method === 'GET' && path === '/dashboard3/api/definitions') {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => /\.(yaml|json)$/.test(f));
        const definitions = files.map(f => {
          const name = f.replace(/\.(yaml|json)$/, '');
          try {
            const raw = fs.readFileSync(nodePath.join(WORKFLOWS_DIR, f), 'utf8');
            const def = (f.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)) as Record<string, unknown>;
            const trigger = def['trigger'] as Record<string, unknown> | undefined;
            return { name, description: (def['description'] as string) ?? '', steps: ((def['steps'] as unknown[]) ?? []).length, trigger: trigger?.['type'] ?? 'manual', schedule: trigger?.['schedule'] ?? null, webhook_key: trigger?.['webhook_key'] ?? null };
          } catch { return { name, error: 'parse error' }; }
        });
        return this.json(res, 200, { definitions });
      }

      // Save a workflow definition
      if (method === 'POST' && path === '/dashboard3/api/definitions') {
        const body = await this.readBody(req);
        const { name, definition } = JSON.parse(body) as { name: string; definition: unknown };
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        const fp = nodePath.join(WORKFLOWS_DIR, `${name}.yaml`);
        const out = typeof definition === 'string' ? definition : yaml.dump(definition, { lineWidth: 120 });
        fs.writeFileSync(fp, out, 'utf8');
        return this.json(res, 200, { saved: true, name });
      }

      // Delete a workflow definition
      const wf3DefDeleteMatch = path.match(/^\/dashboard3\/api\/definitions\/(.+)$/);
      if (method === 'DELETE' && wf3DefDeleteMatch) {
        const name = decodeURIComponent(wf3DefDeleteMatch[1]!);
        let deleted = false;
        for (const ext of ['yaml', 'json']) {
          const fp = nodePath.join(WORKFLOWS_DIR, `${name}.${ext}`);
          if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted = true; }
        }
        if (!deleted) return this.json(res, 404, { error: `Workflow not found: ${name}` });
        res.writeHead(204); res.end(); return;
      }

      // Run a workflow (async — dashboard polls for updates)
      if (method === 'POST' && path === '/dashboard3/api/run') {
        const body = await this.readBody(req);
        const { name, payload } = JSON.parse(body) as { name: string; payload?: unknown };
        const result = await this.params.skillsEngine.execute('workflow_run', { name, payload: payload ?? {}, async: true } as Record<string, unknown>, {
          node_id: 'dashboard3', session_id: `dash-${Date.now()}`, agent_id: 'dashboard3',
          anp:    { sendCommand: () => {} },
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // Trigger a webhook key (fires matching workflows)
      if (method === 'POST' && path === '/dashboard3/api/trigger') {
        const body = await this.readBody(req);
        const { webhook_key, payload } = JSON.parse(body) as { webhook_key: string; payload?: unknown };
        const result = await this.params.skillsEngine.execute('workflow_trigger_webhook', { webhook_key, payload: payload ?? {} } as Record<string, unknown>, {
          node_id: 'dashboard3', session_id: `dash-${Date.now()}`, agent_id: 'dashboard3',
          anp:    { sendCommand: () => {} },
          memory: { search: async () => [] },
          channel:{ send: async () => {} },
          canvas: { append: () => {}, clear: () => {} },
        });
        return this.json(res, 200, result);
      }

      // Workflow templates
      if (method === 'GET' && path === '/dashboard3/api/templates') {
        return this.json(res, 200, WF3_TEMPLATES);
      }

      // ── Dashboard4: Agent Teams ───────────────────────────────────────────────

      // Serve HTML
      if (method === 'GET' && (path === '/dashboard4' || path === '/dashboard4/')) {
        const htmlPath = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'dashboard4.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Receive live events from orchestrator
      if (method === 'POST' && path === '/dashboard4/api/event') {
        const body = await this.readBody(req);
        const evt = JSON.parse(body) as { type: string; data: Record<string, unknown>; ts: number };
        const sessionId = (evt.data['session_id'] as string) ?? 'unknown';
        team4Push(sessionId, evt.type, evt.data, evt.ts ?? Date.now());
        return this.json(res, 200, { ok: true });
      }

      // Get all sessions with their events
      if (method === 'GET' && path === '/dashboard4/api/sessions') {
        const sessions = this.params.orchestrator.getSessions();
        const enriched = sessions.map(s => ({
          ...s,
          events: team4Events.get(s.id) ?? [],
        }));
        return this.json(res, 200, enriched);
      }

      // Spawn a new team asynchronously from the dashboard
      if (method === 'POST' && path === '/dashboard4/api/spawn') {
        const body = await this.readBody(req);
        const args = JSON.parse(body) as Record<string, unknown>;
        const sessionId = this.params.orchestrator.spawnTeamAsync(args, 'dashboard4');
        return this.json(res, 200, { session_id: sessionId, started: true });
      }

      // 404
      return this.json(res, 404, { error: 'Not found' });

    } catch (err) {
      console.error('[REST] Handler error:', err);
      this.json(res, 500, { error: String(err) });
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
