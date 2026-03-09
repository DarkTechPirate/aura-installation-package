#!/usr/bin/env node
/**
 * AURA Gateway CLI
 *
 *   node agent.js onboard    — guided setup wizard
 *   node agent.js --daemon   — run as background service
 *   node agent.js status     — check if running
 *   node agent.js stop       — stop the daemon
 *   node agent.js logs       — tail the log file
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Paths ───────────────────────────────────────────────────────────────────
const AURA_DIR    = path.join(os.homedir(), '.aura');
const LOG_DIR     = path.join(AURA_DIR, 'logs');
const LOG_FILE    = path.join(LOG_DIR, 'aura.log');
const PID_FILE    = path.join(AURA_DIR, 'aura.pid');
const ENV_FILE    = path.join(__dirname, '.env');
const TSX_BIN     = path.join(__dirname, 'node_modules', '.bin', 'tsx');
const SERVER_TS   = path.join(__dirname, 'src', 'server.ts');
const DEFAULT_SKILLS = path.join(__dirname, 'default-skills');
const SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const SYSTEMD_SVC = path.join(SYSTEMD_DIR, 'aura-gateway.service');

// ── ANSI colours ────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM  = '\x1b[2m';
const GRN  = '\x1b[32m';
const YLW  = '\x1b[33m';
const RED  = '\x1b[31m';
const CYN  = '\x1b[36m';
const BLU  = '\x1b[34m';

const ok   = (s) => `${GRN}✓${R} ${s}`;
const fail = (s) => `${RED}✗${R} ${s}`;
const info = (s) => `${CYN}→${R} ${s}`;
const warn = (s) => `${YLW}!${R} ${s}`;
const hdr  = (s) => `\n${BOLD}${CYN}── ${s} ──${R}`;
const dim  = (s) => `${DIM}${s}${R}`;
const bold = (s) => `${BOLD}${s}${R}`;

// ── Port helpers ─────────────────────────────────────────────────────────────
/**
 * Kill any process listening on the given TCP port.
 * Tries three strategies in order: Linux /proc, macOS lsof, Windows netstat.
 */
function killPort(port) {
  const platform = os.platform();

  // ── Linux: parse /proc/net/tcp directly (no external tools) ────────────────
  if (platform === 'linux') {
    try {
      const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
      const inodes = new Set();
      for (const tcpFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          for (const line of fs.readFileSync(tcpFile, 'utf8').split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 10) continue;
            if (parts[3] === '0A' && (parts[1] ?? '').toUpperCase().endsWith(':' + hexPort)) {
              inodes.add(parts[9]);
            }
          }
        } catch { /* file absent */ }
      }
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          for (const fd of fs.readdirSync(`/proc/${entry}/fd`)) {
            try {
              const m = fs.readlinkSync(`/proc/${entry}/fd/${fd}`).match(/socket:\[(\d+)\]/);
              if (m && inodes.has(m[1])) { process.kill(parseInt(entry, 10), 'SIGKILL'); break; }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* /proc not available */ }
    return;
  }

  // ── macOS: use lsof ─────────────────────────────────────────────────────────
  if (platform === 'darwin') {
    try {
      const r = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
      for (const pid of (r.stdout ?? '').trim().split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* skip */ }
      }
    } catch { /* lsof not available */ }
    return;
  }

  // ── Windows: use netstat + taskkill ─────────────────────────────────────────
  if (platform === 'win32') {
    try {
      const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', shell: true });
      const re = new RegExp(`0\\.0\\.0\\.0:${port}|127\\.0\\.0\\.1:${port}|\\[::\\]:${port}`);
      for (const line of (r.stdout ?? '').split('\n')) {
        if (!re.test(line) || !line.includes('LISTENING')) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) {
          spawnSync('taskkill', ['/PID', pid, '/F'], { shell: true, stdio: 'ignore' });
        }
      }
    } catch { /* skip */ }
  }
}

// Wait until a port is no longer in use (Linux only, best-effort)
function waitPortFree(port, timeoutMs = 3000) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let inUse = false;
    try {
      for (const tcpFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          for (const line of fs.readFileSync(tcpFile, 'utf8').split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) continue;
            if (parts[3] === '0A' && (parts[1] ?? '').toUpperCase().endsWith(':' + hexPort)) {
              inUse = true;
            }
          }
        } catch { /* ignore */ }
      }
    } catch { break; }
    if (!inUse) return;
    // Busy-wait in 50ms slices (synchronous — only called before spawn)
    const until = Date.now() + 50;
    while (Date.now() < until) { /* spin */ }
  }
}

function killGatewayPorts() {
  for (const port of [3000, 3001, 3002, 8765]) killPort(port);
}

async function killGatewayPortsAndWait() {
  killGatewayPorts();
  // Poll until all ports are free (up to 3s each)
  if (os.platform() === 'linux') {
    for (const port of [3000, 3001, 3002, 8765]) waitPortFree(port, 3000);
  } else {
    // On non-Linux just wait a fixed 1.5s
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Readline helpers ─────────────────────────────────────────────────────────
function ask(rl, question, defaultVal = '') {
  const hint = defaultVal ? ` ${dim(`[${defaultVal}]`)}` : '';
  return new Promise((resolve) =>
    rl.question(`${question}${hint}: `, (ans) => resolve(ans.trim() || defaultVal))
  );
}

function askYN(rl, question, defaultYes = false) {
  const hint = defaultYes ? dim('[Y/n]') : dim('[y/N]');
  return new Promise((resolve) =>
    rl.question(`${question} ${hint}: `, (ans) => {
      const v = ans.trim().toLowerCase();
      resolve(v === '' ? defaultYes : v === 'y' || v === 'yes');
    })
  );
}

/** Ask for a secret — plain readline (input visible but reliable across all terminals) */
function askSecret(prompt, rl) {
  return new Promise((resolve) =>
    rl.question(`${prompt}: `, (ans) => resolve(ans.trim()))
  );
}

// ── .env helpers ─────────────────────────────────────────────────────────────
function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function writeEnvFile(vars) {
  const merged = { ...loadEnvFile(), ...vars };
  const lines = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
}

// ── Token generator ──────────────────────────────────────────────────────────
function genToken() {
  return `sk-aura-${crypto.randomBytes(20).toString('hex')}`;
}

/** Read the first node token from ~/.aura/nodes.yaml (plain YAML parse, no dep) */
function readAuraToken() {
  const nodesPath = path.join(AURA_DIR, 'nodes.yaml');
  if (!fs.existsSync(nodesPath)) return null;
  const content = fs.readFileSync(nodesPath, 'utf8');
  const m = content.match(/token:\s*["']?([^\s"'\n]+)["']?/);
  return m ? m[1] : null;
}

// ── Config generators ────────────────────────────────────────────────────────
function genConfigYaml(opts) {
  const ollamaModel  = opts.ollamaModel ?? 'llama3.2:3b';
  const llmDefault = opts.llm === 'openai' ? 'gpt-4o-mini'
                   : opts.llm === 'ollama'  ? `ollama/${ollamaModel}`
                   : 'claude-haiku-4-5';
  const llmComplex = opts.llm === 'openai' ? 'gpt-4o'
                   : opts.llm === 'ollama'  ? `ollama/${ollamaModel}`
                   : 'claude-sonnet-4-6';
  const llmCreative = opts.llm === 'ollama' ? `ollama/${ollamaModel}` : llmComplex;

  const channelBlock = (name, extra = '') =>
    `  ${name}:\n    enabled: ${opts.channels.includes(name) ? 'true' : 'false'}${extra}`;

  return `agent:
  name: "${opts.agentName}"
  persona: >
    ${opts.persona}

llm:
  default: ${llmDefault}
  routing:
    simple:   ${llmDefault}
    complex:  ${llmComplex}
    vision:   ${llmComplex}
    creative: ${llmCreative}
    offline:  ollama/llama3.2:3b

  providers:
    claude:
      api_key: \${ANTHROPIC_API_KEY}
      models: [claude-haiku-4-5, claude-sonnet-4-6]
    openai:
      api_key: \${OPENAI_API_KEY}
      models: [gpt-4o, gpt-4o-mini]
    ollama:
      base_url: http://localhost:11434
      models: [${ollamaModel}]
    gemini:
      api_key: \${GOOGLE_API_KEY}
      models: [gemini-1.5-flash]

channels:
${channelBlock('telegram', '\n    token: ${TELEGRAM_BOT_TOKEN}')}
${channelBlock('whatsapp')}
${channelBlock('signal', '\n    phone_number: ${SIGNAL_PHONE_NUMBER}\n    signal_cli: /usr/local/bin/signal-cli')}
${channelBlock('slack', '\n    bot_token: ${SLACK_BOT_TOKEN}\n    signing_secret: ${SLACK_SIGNING_SECRET}\n    app_token: ${SLACK_APP_TOKEN}')}
${channelBlock('discord', '\n    token: ${DISCORD_BOT_TOKEN}')}
${channelBlock('google_chat', '\n    credentials: ${GOOGLE_CHAT_CREDENTIALS_PATH}')}
${channelBlock('teams', '\n    app_id: ${TEAMS_APP_ID}\n    app_secret: ${TEAMS_APP_SECRET}')}
  webchat:
    enabled: true
    port: 3000

voice:
  tts:
    provider: ${opts.voice ? 'elevenlabs' : 'none'}
    api_key: \${ELEVENLABS_API_KEY}
    voice_id: 21m00Tcm4TlvDq8ikWAM
  stt:
    provider: whisper_api
    api_key: \${OPENAI_API_KEY}

canvas:
  enabled: true
  port: 3001

scheduler:
  heartbeat_interval_min: 30
  reminder_check_sec: 60
  nightly_summary_time: "23:30"

security:
  bind_address: 127.0.0.1
  anp_port: 8765
  rest_port: 3002
`;
}

function genNodesYaml(token) {
  return `nodes:
  - id: test_01
    token: "${token}"
    caps: [text_in, text_out]
    meta: {}
`;
}

function genAgentsYaml(agentName, persona) {
  return `agents:
  - id: personal
    name: "${agentName}"
    description: "Primary personal assistant"
    persona: >
      ${persona}
    channels:
      - telegram_personal
      - whatsapp_personal
      - aura_body_01
      - aura_mobile_01
    skills:
      - web_search
      - reminders
      - google_calendar
      - notion
      - webhooks
    llm_tier: simple
    voice_id: 21m00Tcm4TlvDq8ikWAM
    memory_ns: personal

  - id: default
    name: "${agentName}"
    description: "Fallback agent"
    persona: "You are ${agentName}. Be helpful and brief."
    channels: [__default__]
    skills: [web_search, reminders]
    llm_tier: simple
    voice_id: null
    memory_ns: default
`;
}

function genHeartbeatMd(agentName) {
  return `## Every 30 minutes
- Check reminders table — fire any with fire_at <= now
- If body node last status > 10 minutes ago: log warning

## Morning (07:00–09:00 weekdays)
- Compose a brief good morning greeting (under 2 sentences)
- Use send_to_agent_channels to send to personal channels

## Evening (21:00–21:30 weekdays)
- Summarise the day from episodic memory
- Use send_to_agent_channels to send summary to personal channels

## Silent rule (CRITICAL)
- If none of the above apply: respond ONLY "HEARTBEAT_OK"
- No message is always better than a pointless message
`;
}

// ── Daemon helpers ───────────────────────────────────────────────────────────
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const n = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  return isNaN(n) ? null : n;
}

function hasSystemd() {
  const result = spawnSync('systemctl', ['--user', 'list-units', '--no-pager'], {
    stdio: 'ignore', timeout: 2000,
  });
  return result.status === 0;
}

function installSystemdService() {
  const envPath = fs.existsSync(ENV_FILE) ? ENV_FILE : '';
  const service = `[Unit]
Description=AURA Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${__dirname}
${envPath ? `EnvironmentFile=${envPath}` : '# No .env file found'}
ExecStart=${process.execPath} ${TSX_BIN} ${SERVER_TS}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(SYSTEMD_SVC, service, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  spawnSync('systemctl', ['--user', 'enable', 'aura-gateway'], { stdio: 'inherit' });
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdOnboard() {
  console.log(`\n${BOLD}${CYN}╔══════════════════════════════════════╗${R}`);
  console.log(`${BOLD}${CYN}║     AURA Gateway Setup Wizard        ║${R}`);
  console.log(`${BOLD}${CYN}╚══════════════════════════════════════╝${R}\n`);

  // Check Node.js version
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.log(fail(`Node.js ${process.versions.node} detected. Node 20+ required.`));
    process.exit(1);
  }
  console.log(ok(`Node.js ${process.versions.node}`));

  // Check tsx / install deps
  if (!fs.existsSync(TSX_BIN)) {
    console.log(warn('node_modules not found. Running npm install first...'));
    const r = spawnSync('npm', ['install', '--ignore-scripts'], { cwd: __dirname, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      console.log(fail('npm install failed. Fix errors above and retry.'));
      process.exit(1);
    }
  }
  console.log(ok('Dependencies ready'));

  // Rebuild better-sqlite3 native addon for this machine's Node.js ABI.
  // npm install fetches prebuilt binaries that may not match — rebuild ensures it works.
  console.log(info('Building native modules for this machine...'));
  const rebuildResult = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
    cwd: __dirname, stdio: 'inherit', shell: true,
  });
  if (rebuildResult.status !== 0) {
    console.log(warn('better-sqlite3 rebuild failed — you may need build tools (python3, make, g++).'));
    console.log(warn('On Ubuntu/Debian: sudo apt install -y python3 make g++'));
  } else {
    console.log(ok('Native modules ready'));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── Step 1: Agent name ─────────────────────────────────────────────────
    console.log(hdr('Step 1 / 5: Agent identity'));
    const agentName = await ask(rl, 'Agent name', 'AURA');
    const persona   = await ask(rl, 'Persona (one sentence)',
      `You are ${agentName}, a warm and direct personal AI. Keep voice responses under 3 sentences.`);

    // ── Step 2: LLM provider ───────────────────────────────────────────────
    console.log(hdr('Step 2 / 5: LLM provider'));
    console.log(`  ${bold('1')} Claude (Anthropic) — recommended`);
    console.log(`  ${bold('2')} OpenAI (GPT-4o)`);
    console.log(`  ${bold('3')} Ollama (local, no API key needed)`);
    console.log(`  ${bold('4')} Gemini (Google)`);
    const llmChoice = await ask(rl, 'Choose provider', '1');

    const llmMap = { '1': 'claude', '2': 'openai', '3': 'ollama', '4': 'gemini' };
    const llm = llmMap[llmChoice] ?? 'claude';
    const envVars = {};
    let ollamaModel = 'llama3.2:3b';

    if (llm === 'claude') {
      envVars.ANTHROPIC_API_KEY = await askSecret('  Anthropic API key (sk-ant-...)', rl);
    } else if (llm === 'openai') {
      envVars.OPENAI_API_KEY = await askSecret('  OpenAI API key (sk-...)', rl);
    } else if (llm === 'ollama') {
      console.log(info('Checking Ollama for available models...'));
      try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (res.ok) {
          const data = await res.json();
          const models = (data.models ?? []).map(m => m.name);
          if (models.length > 0) {
            console.log(dim(`  Available models: ${models.join(', ')}`));
          } else {
            console.log(warn('  No models pulled yet. Run: ollama pull llama3.2:3b'));
          }
        }
      } catch {
        console.log(warn('  Ollama not reachable at localhost:11434 — start it first.'));
      }
      ollamaModel = await ask(rl, '  Model name', 'llama3.2:3b');
    } else if (llm === 'gemini') {
      envVars.GOOGLE_API_KEY = await askSecret('  Google API key', rl);
    }

    // ── Step 3: Channels ───────────────────────────────────────────────────
    console.log(hdr('Step 3 / 5: Messaging channels'));
    console.log(dim('  WebChat (browser WebSocket) is always enabled — no credentials needed.'));
    const enabledChannels = [];

    const channelDefs = [
      { id: 'telegram',    label: 'Telegram',     vars: [['TELEGRAM_BOT_TOKEN', 'Bot token (from @BotFather)']] },
      { id: 'discord',     label: 'Discord',      vars: [['DISCORD_BOT_TOKEN', 'Bot token']] },
      { id: 'slack',       label: 'Slack',        vars: [['SLACK_BOT_TOKEN','Bot token (xoxb-...)'], ['SLACK_SIGNING_SECRET','Signing secret'], ['SLACK_APP_TOKEN','App token (xapp-...) for Socket Mode']] },
      { id: 'whatsapp',    label: 'WhatsApp',     vars: [] },
      { id: 'signal',      label: 'Signal',       vars: [['SIGNAL_PHONE_NUMBER','Phone number (+country code)']] },
    ];

    for (const ch of channelDefs) {
      const yes = await askYN(rl, `  Enable ${bold(ch.label)}?`, false);
      if (!yes) continue;
      enabledChannels.push(ch.id);
      for (const [envKey, promptText] of ch.vars) {
        envVars[envKey] = await askSecret(`    ${promptText}`, rl);
      }
      if (ch.id === 'whatsapp') console.log(info('WhatsApp: QR scan required on first start.'));
    }

    // ── Step 4: Voice (optional) ───────────────────────────────────────────
    console.log(hdr('Step 4 / 5: Voice synthesis (optional)'));
    const voice = await askYN(rl, `  Enable ElevenLabs TTS?`, false);
    if (voice) {
      envVars.ELEVENLABS_API_KEY = await askSecret('  ElevenLabs API key', rl);
    }

    // ── Step 5: Write files ────────────────────────────────────────────────
    console.log(hdr('Step 5 / 5: Writing config'));

    // Ensure dirs
    for (const d of [AURA_DIR, LOG_DIR,
      path.join(AURA_DIR, 'skills'), path.join(AURA_DIR, 'memory'),
      path.join(AURA_DIR, 'tokens'), path.join(AURA_DIR, 'memory', 'personal')]) {
      fs.mkdirSync(d, { recursive: true });
    }

    // .env
    writeEnvFile(envVars);
    console.log(ok(`.env written → ${ENV_FILE}`));

    // config.yaml
    const configYaml = genConfigYaml({ llm, ollamaModel, channels: enabledChannels, agentName, persona, voice });
    fs.writeFileSync(path.join(AURA_DIR, 'config.yaml'), configYaml, 'utf8');
    console.log(ok(`config.yaml → ~/.aura/config.yaml`));

    // nodes.yaml (only if not exists — preserve existing tokens)
    const nodesPath = path.join(AURA_DIR, 'nodes.yaml');
    if (!fs.existsSync(nodesPath)) {
      const token = genToken();
      fs.writeFileSync(nodesPath, genNodesYaml(token), 'utf8');
      console.log(ok(`nodes.yaml → ~/.aura/nodes.yaml`));
    } else {
      console.log(ok('nodes.yaml already exists — preserved'));
    }

    // agents.yaml (only if not exists)
    const agentsPath = path.join(AURA_DIR, 'agents.yaml');
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, genAgentsYaml(agentName, persona), 'utf8');
      console.log(ok(`agents.yaml → ~/.aura/agents.yaml`));
    } else {
      console.log(ok('agents.yaml already exists — preserved'));
    }

    // HEARTBEAT.md (only if not exists)
    const hbPath = path.join(AURA_DIR, 'HEARTBEAT.md');
    if (!fs.existsSync(hbPath)) {
      fs.writeFileSync(hbPath, genHeartbeatMd(agentName), 'utf8');
      console.log(ok('HEARTBEAT.md → ~/.aura/HEARTBEAT.md'));
    }

    // Skills node_modules symlink — so skills can import gateway packages (better-sqlite3 etc.)
    const skillsModules = path.join(AURA_DIR, 'skills', 'node_modules');
    const gatewayModules = path.join(__dirname, 'node_modules');
    try {
      if (fs.existsSync(skillsModules)) fs.rmSync(skillsModules, { recursive: true, force: true });
      fs.symlinkSync(gatewayModules, skillsModules, 'dir');
      console.log(ok(`Skills node_modules linked → ~/.aura/skills/node_modules`));
    } catch (e) {
      console.log(warn(`Could not symlink node_modules: ${e.message}`));
    }

    // Default skills — copy bundled skills that don't already exist
    const defaultSkillsDir = DEFAULT_SKILLS;
    const skillsDir        = path.join(AURA_DIR, 'skills');
    if (fs.existsSync(defaultSkillsDir)) {
      const files    = fs.readdirSync(defaultSkillsDir);
      let copied     = 0;
      let skipped    = 0;
      for (const file of files) {
        const dest = path.join(skillsDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(defaultSkillsDir, file), dest);
          copied++;
        } else {
          skipped++;
        }
      }
      const skillCount = files.filter(f => f.endsWith('.yaml')).length;
      console.log(ok(`Skills installed: ${skillCount} skills → ~/.aura/skills/${skipped ? dim(` (${skipped} files already existed, preserved)`) : ''}`));
    } else {
      console.log(warn('default-skills/ folder not found — skills not installed'));
    }

    // ── Done — show full config summary ────────────────────────────────────
    const auraToken = readAuraToken();
    const llmLabel  = llm === 'ollama' ? `ollama / ${ollamaModel}`
                    : llm === 'claude' ? 'Anthropic Claude'
                    : llm === 'openai' ? 'OpenAI GPT'
                    : 'Google Gemini';
    const chLabel   = enabledChannels.length > 0
                    ? enabledChannels.join(', ')
                    : 'webchat only';

    console.log(`\n${BOLD}${GRN}╔══════════════════════════════════════════════════════╗${R}`);
    console.log(`${BOLD}${GRN}║               Setup Complete!                        ║${R}`);
    console.log(`${BOLD}${GRN}╚══════════════════════════════════════════════════════╝${R}`);
    console.log(`\n  ${bold('Agent')}     : ${agentName}`);
    console.log(`  ${bold('LLM')}       : ${llmLabel}`);
    console.log(`  ${bold('Channels')} : ${chLabel}`);
    console.log(`  ${bold('Voice')}     : ${voice ? 'ElevenLabs TTS' : 'disabled'}`);

    if (auraToken) {
      console.log(`\n  ${BOLD}${YLW}ANP Node Token (for connecting AURA clients):${R}`);
      console.log(`  ${BOLD}${CYN}${auraToken}${R}`);
      console.log(`  ${DIM}Save this — it authenticates ANP WebSocket connections${R}`);
    }

    const envKeys = Object.keys(envVars).filter(k => envVars[k]);
    if (envKeys.length > 0) {
      console.log(`\n  ${bold('Env vars written to .env:')}`);
      for (const k of envKeys) {
        const masked = envVars[k].length > 8
          ? envVars[k].slice(0, 4) + '****' + envVars[k].slice(-4)
          : '****';
        console.log(`    ${GRN}${k}${R} = ${dim(masked)}`);
      }
    }

    console.log(`\n  ${bold('Next steps:')}`);
    console.log(`    Run in foreground : ${bold('npm run dev')}`);
    console.log(`    Run as daemon     : ${bold('node agent.js --daemon')}`);
    console.log(`    Check status      : ${bold('node agent.js status')}`);
    console.log(`    View logs         : ${bold('node agent.js logs')}\n`);

    const startNow = await askYN(rl, 'Start the gateway now in foreground?', true);
    rl.close();
    if (startNow) {
      // Kill any existing gateway processes and wait until ports are actually free
      await killGatewayPortsAndWait();
      console.log('');
      const env = { ...process.env, ...loadEnvFile() };
      spawn(TSX_BIN, [SERVER_TS], { cwd: __dirname, stdio: 'inherit', env }).on('exit', (code) => {
        process.exit(code ?? 0);
      });
    }
  } catch (e) {
    rl.close();
    console.error(fail(String(e)));
    process.exit(1);
  }
}

async function cmdDaemon() {
  if (!fs.existsSync(TSX_BIN)) {
    console.log(fail('node_modules not found. Run: node agent.js onboard'));
    process.exit(1);
  }

  // Check if already running via PID file
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(warn(`Already running (PID ${existingPid}). Use: node agent.js status`));
    process.exit(0);
  }

  // Kill any orphaned processes holding gateway ports (e.g. from a previous crashed run)
  await killGatewayPortsAndWait();

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Try systemd first
  if (hasSystemd()) {
    console.log(info('systemd detected — installing user service...'));
    installSystemdService();
    const r = spawnSync('systemctl', ['--user', 'start', 'aura-gateway'], { stdio: 'inherit' });
    if (r.status === 0) {
      console.log(ok('Started via systemd (aura-gateway.service)'));
      console.log(info(`Logs: journalctl --user -u aura-gateway -f`));
      console.log(info(`Stop: node agent.js stop`));
    } else {
      console.log(fail('systemd start failed — falling back to detached process'));
      spawnDetached();
    }
    return;
  }

  spawnDetached();
}

function spawnDetached() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const env   = { ...process.env, ...loadEnvFile() };

  const child = spawn(TSX_BIN, [SERVER_TS], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(ok(`AURA Gateway started (PID ${child.pid})`));
  console.log(info(`Logs: ${LOG_FILE}`));
  console.log(info(`Stop: node agent.js stop`));
}

function cmdStatus() {
  console.log('');

  // Check systemd first
  if (hasSystemd() && fs.existsSync(SYSTEMD_SVC)) {
    const r = spawnSync('systemctl', ['--user', 'is-active', 'aura-gateway'], {
      encoding: 'utf8', stdio: 'pipe',
    });
    const active = r.stdout.trim();
    if (active === 'active') {
      console.log(ok(`systemd service: ${GRN}${bold('active')}${R}`));
      const status = spawnSync('systemctl', ['--user', 'show', 'aura-gateway',
        '--property=MainPID,ExecStart,ActiveEnterTimestamp'], { encoding: 'utf8', stdio: 'pipe' });
      for (const line of status.stdout.split('\n')) {
        if (line.trim()) console.log(`  ${dim(line)}`);
      }
    } else {
      console.log(fail(`systemd service: ${RED}${bold(active || 'inactive')}${R}`));
    }
    console.log('');
    return;
  }

  // PID file check
  const pid = readPid();
  if (!pid) {
    console.log(fail('Not running (no PID file)'));
  } else if (isRunning(pid)) {
    console.log(ok(`Running — PID ${bold(pid)}`));
    console.log(info(`Log file: ${LOG_FILE}`));
    // Show last 3 log lines
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-3);
      console.log(`\n${DIM}Recent logs:${R}`);
      for (const l of lines) console.log(`  ${dim(l)}`);
    }
  } else {
    console.log(fail(`Not running (stale PID ${pid})`));
    fs.unlinkSync(PID_FILE);
  }
  console.log('');

  // Show config summary
  const cfg = path.join(AURA_DIR, 'config.yaml');
  if (fs.existsSync(cfg)) {
    console.log(info(`Config: ${cfg}`));
  }
  const env = loadEnvFile();
  const keys = Object.keys(env).filter(k => k.endsWith('_KEY') || k.endsWith('_TOKEN') || k.endsWith('_SECRET'));
  if (keys.length) {
    console.log(info(`Env keys set: ${keys.map(k => `${GRN}${k}${R}`).join(', ')}`));
  }
  console.log('');
}

function cmdStop() {
  // systemd
  if (hasSystemd() && fs.existsSync(SYSTEMD_SVC)) {
    const r = spawnSync('systemctl', ['--user', 'stop', 'aura-gateway'], { stdio: 'inherit' });
    if (r.status === 0) {
      console.log(ok('Stopped systemd service'));
    } else {
      console.log(fail('Failed to stop systemd service'));
    }
    return;
  }

  // PID file
  const pid = readPid();
  if (!pid) {
    console.log(warn('Not running'));
    return;
  }
  if (!isRunning(pid)) {
    console.log(warn(`Process ${pid} not found — cleaning up stale PID file`));
    fs.unlinkSync(PID_FILE);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Wait up to 5s for graceful shutdown
    let waited = 0;
    const interval = setInterval(() => {
      waited += 200;
      if (!isRunning(pid)) {
        clearInterval(interval);
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        console.log(ok(`Stopped (PID ${pid})`));
      } else if (waited >= 5000) {
        clearInterval(interval);
        process.kill(pid, 'SIGKILL');
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        console.log(ok(`Force-killed (PID ${pid})`));
      }
    }, 200);
  } catch (e) {
    console.log(fail(`Could not stop process: ${e.message}`));
  }
}

function cmdLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    // Try journalctl for systemd
    if (hasSystemd() && fs.existsSync(SYSTEMD_SVC)) {
      console.log(info('Tailing journalctl (Ctrl-C to exit)...\n'));
      spawn('journalctl', ['--user', '-u', 'aura-gateway', '-f', '--no-pager'], {
        stdio: 'inherit',
      });
      return;
    }
    console.log(warn(`No log file at ${LOG_FILE}`));
    console.log(info('Start the daemon first: node agent.js --daemon'));
    return;
  }

  console.log(info(`Tailing ${LOG_FILE} (Ctrl-C to exit)...\n`));

  // Print last 30 lines then follow
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const tail = content.split('\n').slice(-30).join('\n');
  if (tail.trim()) process.stdout.write(tail + '\n');

  // Watch for new content
  let size = fs.statSync(LOG_FILE).size;
  const watcher = fs.watch(LOG_FILE, () => {
    const newSize = fs.statSync(LOG_FILE).size;
    if (newSize > size) {
      const fd = fs.openSync(LOG_FILE, 'r');
      const buf = Buffer.alloc(newSize - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf8'));
      size = newSize;
    }
  });

  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
}

async function cmdUninstall() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${BOLD}${RED}AURA Gateway — Uninstall${R}\n`);
  console.log('This will remove:\n');
  console.log(`  • All config, memory & skills  → ${AURA_DIR}`);
  console.log(`  • Gateway files                → ${__dirname}`);
  console.log(`  • Systemd service              → aura-gateway.service (if installed)`);
  console.log(`  • Log files\n`);

  const confirm = await new Promise(r =>
    rl.question(`Type ${BOLD}yes${R} to confirm: `, r)
  );
  rl.close();

  if (confirm.trim().toLowerCase() !== 'yes') {
    console.log(warn('Uninstall cancelled.'));
    return;
  }

  // 1. Stop running gateway
  console.log('\n' + info('Stopping gateway…'));
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  killGatewayPorts();

  // 2. Remove systemd service
  const systemdFile = path.join(os.homedir(), '.config', 'systemd', 'user', 'aura-gateway.service');
  if (fs.existsSync(systemdFile)) {
    console.log(info('Removing systemd service…'));
    spawnSync('systemctl', ['--user', 'stop',    'aura-gateway'], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'disable',  'aura-gateway'], { stdio: 'ignore' });
    fs.rmSync(systemdFile, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    console.log(ok('Systemd service removed'));
  }

  // 3. Remove ~/.aura
  if (fs.existsSync(AURA_DIR)) {
    console.log(info(`Removing ${AURA_DIR}…`));
    fs.rmSync(AURA_DIR, { recursive: true, force: true });
    console.log(ok('Config & data removed'));
  }

  // 4. Remove gateway directory itself
  console.log(info(`Removing ${__dirname}…`));
  // Schedule self-deletion via shell after this process exits
  const rmCmd = `sleep 1 && rm -rf ${JSON.stringify(__dirname)}`;
  spawn('sh', ['-c', rmCmd], { detached: true, stdio: 'ignore' }).unref();

  console.log(`\n${ok('AURA Gateway uninstalled.')} Folder will be deleted in a moment.\n`);
}

const PAUSE_MARKER = path.join(AURA_DIR, 'aura.paused');

function cmdPause() {
  // systemd path — stop + disable so it won't auto-start on next boot
  if (hasSystemd() && fs.existsSync(SYSTEMD_SVC)) {
    const stop = spawnSync('systemctl', ['--user', 'stop', 'aura-gateway'], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'disable', 'aura-gateway'], { stdio: 'pipe' });
    if (stop.status === 0) {
      console.log(ok('Gateway paused (systemd service stopped and disabled).'));
    } else {
      console.log(warn('Gateway may not have been running — disabled auto-start anyway.'));
    }
    console.log(info(`Resume with: ${BOLD}node agent.js resume${R}`));
    return;
  }

  // PID file path — stop the process and drop a marker file
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      let waited = 0;
      const interval = setInterval(() => {
        waited += 200;
        if (!isRunning(pid) || waited >= 5000) {
          clearInterval(interval);
          if (!isRunning(pid)) {
            if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
          } else {
            process.kill(pid, 'SIGKILL');
            if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
          }
          fs.writeFileSync(PAUSE_MARKER, new Date().toISOString(), 'utf8');
          console.log(ok('Gateway paused.'));
          console.log(info(`Resume with: ${BOLD}node agent.js resume${R}`));
        }
      }, 200);
    } catch (e) {
      console.log(fail(`Could not stop process: ${e.message}`));
    }
  } else {
    // Not running — just write the marker so resume knows it was deliberately paused
    fs.writeFileSync(PAUSE_MARKER, new Date().toISOString(), 'utf8');
    console.log(warn('Gateway was not running — marked as paused.'));
    console.log(info(`Resume with: ${BOLD}node agent.js resume${R}`));
  }
}

async function cmdResume() {
  // systemd path — enable + start
  if (hasSystemd() && fs.existsSync(SYSTEMD_SVC)) {
    spawnSync('systemctl', ['--user', 'enable', 'aura-gateway'], { stdio: 'pipe' });
    const r = spawnSync('systemctl', ['--user', 'start', 'aura-gateway'], { stdio: 'inherit' });
    if (r.status === 0) {
      console.log(ok('Gateway resumed (systemd service enabled and started).'));
      console.log(info('Check status with: node agent.js status'));
    } else {
      console.log(fail('Failed to start systemd service — try: node agent.js --daemon'));
    }
    return;
  }

  // PID file path — remove marker then launch daemon
  if (fs.existsSync(PAUSE_MARKER)) fs.unlinkSync(PAUSE_MARKER);
  console.log(info('Resuming gateway…'));
  await cmdDaemon();
}

function cmdHelp() {
  console.log(`
${BOLD}${CYN}AURA Gateway CLI${R}

${BOLD}Usage:${R}
  node agent.js ${GRN}onboard${R}     Guided setup wizard (run this first)
  node agent.js ${GRN}--daemon${R}    Start gateway as background service
  node agent.js ${GRN}status${R}      Show running status and config summary
  node agent.js ${GRN}stop${R}        Gracefully stop the daemon
  node agent.js ${GRN}pause${R}       Pause the gateway (stops + disables auto-start)
  node agent.js ${GRN}resume${R}      Resume a paused gateway
  node agent.js ${GRN}logs${R}        Tail the gateway log (Ctrl-C to exit)
  node agent.js ${GRN}uninstall${R}   Remove AURA Gateway from this machine

${BOLD}Quick start:${R}
  node agent.js onboard
  node agent.js --daemon
  node agent.js status

${BOLD}Direct run (foreground):${R}
  npm run dev
  npm start
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];

switch (cmd) {
  case 'onboard':    await cmdOnboard(); break;
  case '--daemon':   await cmdDaemon(); break;
  case 'status':     await cmdStatus(); break;
  case 'stop':       cmdStop(); break;
  case 'pause':      cmdPause(); break;
  case 'resume':     await cmdResume(); break;
  case 'logs':       cmdLogs(); break;
  case 'uninstall':  await cmdUninstall(); break;
  default:           cmdHelp(); break;
}
