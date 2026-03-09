# AURA Gateway

A self-hosted, always-on AI agent brain. Seven messaging channels, four LLM backends, 11 skill integrations, proactive heartbeat scheduling, voice synthesis, a live canvas workspace, a full browser dashboard, and a REST API — all running on a home PC or Mac.

---

## Architecture overview

```
                    ┌─────────────────────────────────────┐
                    │           AURA Gateway              │
                    │                                     │
Telegram ──────────►│  Channel      ANP WebSocket         │
WhatsApp ──────────►│  Manager  ◄── Server :8765          │◄── hardware nodes
Signal   ──────────►│    │          (body, mobile)        │    (aura_body_01 …)
Slack    ──────────►│    │                                │
Discord  ──────────►│    └──► Core Event Loop             │
Google Chat ───────►│            │                        │
Teams    ──────────►│            ▼                        │
Browser  ──────────►│  AgentResolver → ContextBuilder     │
(Dashboard :3000)   │            │                        │
                    │            ▼                        │
                    │    LLM Router (Claude/OpenAI/        │
                    │    Ollama/Gemini)                   │
                    │            │                        │
                    │            ▼                        │
                    │    Skills Engine (11 skills +       │
                    │    self-write)                      │
                    │                                     │
                    │    Memory: RAM | Episodic | SQLite  │
                    │            + User Profile           │
                    │            + Self-Knowledge         │
                    │    Scheduler: cron + reminders      │
                    │    Canvas WS :3001                  │
                    │    REST API  :3002                  │
                    └─────────────────────────────────────┘
```

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | 20 LTS or later |
| npm | 9+ (bundled with Node 20) |
| OS | Linux / macOS / Windows (WSL2) |
| Java (optional) | 17+ only if using Signal channel |

> **Node version check:** `agent.cjs` is a CommonJS wrapper that detects your Node version and prints clear upgrade instructions if you're on Node < 20. It works on any Node version — no more silent crashes.

---

## Installation

### 1. Extract the zip

```bash
unzip aura-gateway.zip
cd gateway
```

### 2. Run the setup wizard

```bash
node agent.js onboard
```

The wizard will:
- Check your Node.js version and install dependencies automatically
- Ask which LLM provider to use (Claude, OpenAI, Ollama, or Gemini) and prompt for the API key
- Ask which messaging channels to enable and collect their credentials
- Ask for your agent's name and persona
- Optionally enable ElevenLabs voice synthesis
- Write `.env`, `~/.aura/config.yaml`, `~/.aura/agents.yaml`, and `~/.aura/nodes.yaml`
- Offer to start the gateway immediately when done

That's it. No manual config file editing required.

---

## CLI reference

```
node agent.js onboard    Guided setup wizard (run this first)
node agent.js --daemon   Start gateway as background service
node agent.js status     Show running status and config summary
node agent.js stop       Gracefully stop the daemon
node agent.js pause      Pause the gateway (stops + disables auto-start on boot)
node agent.js resume     Resume a paused gateway
node agent.js logs       Tail the live log (Ctrl-C to exit)
node agent.js uninstall  Remove AURA Gateway from this machine
```

All commands are also available as npm shortcuts:

```bash
npm run onboard
npm run daemon
npm run status
npm run stop
npm run logs
```

### Typical workflow on a new machine

```bash
# 1. Extract and enter the directory
unzip aura-gateway.zip && cd gateway

# 2. Run the wizard — installs deps, writes config, starts gateway
node agent.js onboard

# 3. On subsequent boots, start as a background service
node agent.js --daemon

# 4. Check it's running
node agent.js status

# 5. Watch the live log
node agent.js logs

# 6. Stop it
node agent.js stop
```

### Pause & Resume

```bash
node agent.js pause    # stop the gateway and disable auto-start on boot
node agent.js resume   # re-enable and start it again
```

`pause` is different from `stop`:

| Command | Stops process | Disables auto-start on next boot |
|---|---|---|
| `stop` | Yes | No — systemd would restart it on reboot |
| `pause` | Yes | Yes — gateway stays off until you `resume` |

All your config, memory, and skills are completely untouched. `resume` brings everything back exactly where you left it.

### Uninstall

```bash
node agent.js uninstall
```

Stops the daemon, removes the systemd service, deletes the gateway directory, and optionally removes `~/.aura/` (you are prompted before any data is deleted).

### Background service behaviour

`--daemon` automatically detects the environment:

| Environment | Method used |
|---|---|
| Linux / WSL2 with systemd | Installs `~/.config/systemd/user/aura-gateway.service`, starts via `systemctl --user` |
| WSL2 without systemd / macOS | Detaches process with stdout/stderr → `~/.aura/logs/aura.log`, PID → `~/.aura/aura.pid` |

### Running in foreground (development)

```bash
npm run dev     # hot-reloads on file changes
npm start       # no hot-reload
```

You should see:
```
✅ AURA Gateway started
   ANP WebSocket : ws://127.0.0.1:8765/anp
   REST API      : http://127.0.0.1:3002
   Canvas WS     : ws://127.0.0.1:3001/canvas
   Agents loaded : 2
   Skills loaded : 11
```

---

## Manual installation (without the wizard)

If you prefer to configure everything by hand:

### 1. Install dependencies

```bash
npm install
```

> If the install fails due to native modules (`mdns`, `better-sqlite3`), run:
> ```bash
> npm install --ignore-scripts
> ```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env — minimum: one LLM API key
```

### 3. Run

```bash
npm run dev
```

---

## Configuration files

All config lives in `~/.aura/` — created automatically on first run.

| File | Purpose |
|---|---|
| `~/.aura/config.yaml` | LLM routing, channels, voice, scheduler, security |
| `~/.aura/agents.yaml` | Agent definitions (persona, channels, skills, LLM tier) |
| `~/.aura/nodes.yaml` | Registered hardware/device nodes and their tokens |
| `~/.aura/HEARTBEAT.md` | Instructions for the autonomous heartbeat process |
| `~/.aura/skills/` | Skill YAML definitions + TypeScript executors |
| `~/.aura/memory/` | Episodic `.md` files, SQLite DB, user profiles, canvas state |
| `~/.aura/tokens/` | OAuth tokens (WhatsApp session, Spotify, etc.) |

### config.yaml example

```yaml
agent:
  name: "AURA"
  persona: "You are AURA, a sharp and witty personal AI."

llm:
  routing:
    simple:   claude-haiku-4-5      # fast responses
    complex:  claude-sonnet-4-6     # deep reasoning
    vision:   claude-sonnet-4-6     # image understanding
    creative: claude-opus-4         # creative writing
    offline:  ollama/llama3.2:3b    # no internet needed

channels:
  webchat:
    enabled: true        # browser dashboard — works with no credentials
    port: 3000
  telegram:
    enabled: true
    token: ${TELEGRAM_BOT_TOKEN}
    allowed_ids: [123456789]        # whitelist — only these Telegram IDs can chat
  discord:
    enabled: false
    token: ${DISCORD_BOT_TOKEN}

scheduler:
  heartbeat_interval_min: 30
  reminder_check_sec: 60

security:
  bind_address: 127.0.0.1   # change to 0.0.0.0 for LAN / WSL2 external access
  anp_port: 8765
  rest_port: 3002
```

All `${ENV_VAR}` placeholders are interpolated from your environment at startup. No secrets are stored in plain text in the codebase.

---

## Channels

| Channel | node_id format | Credentials needed |
|---|---|---|
| Telegram | `telegram_<chat_id>` | `TELEGRAM_BOT_TOKEN` |
| WhatsApp | `whatsapp_<phone>` | QR scan on first run |
| Signal | `signal_<phone>` | `signal-cli` + Java 17, `SIGNAL_PHONE_NUMBER` |
| Slack | `slack_<user_id>` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` |
| Discord | `discord_<user_id>` | `DISCORD_BOT_TOKEN` |
| Google Chat | `gchat_<space_id>` | Service account JSON at `GOOGLE_CHAT_CREDENTIALS_PATH` |
| MS Teams | `teams_<conv_id>` | `TEAMS_APP_ID`, `TEAMS_APP_SECRET` |
| WebChat | `browser_<uuid>` | None — full dashboard at `http://<host>:3000` |

Enable or disable any channel in `~/.aura/config.yaml`.

### Telegram allowlist

By default the Telegram channel only responds to Telegram user IDs you explicitly permit. Add your ID (found via [@userinfobot](https://t.me/userinfobot)) to `config.yaml`:

```yaml
channels:
  telegram:
    enabled: true
    token: ${TELEGRAM_BOT_TOKEN}
    allowed_ids: [123456789, 987654321]   # add as many as you like
```

Messages from any other ID are silently dropped and logged. If `allowed_ids` is empty or missing, **all** messages are blocked.

---

## Browser Dashboard

Open `http://<host>:3000` in any browser — no login required on the local network.

The dashboard has five panels, switchable from the left sidebar:

| Panel | What it shows |
|---|---|
| **Chat** | Full conversation UI with markdown rendering, syntax highlighting, typing indicator, and optional Canvas side-panel |
| **Skills** | All loaded skills with enable/disable toggles |
| **Nodes** | Connected ANP hardware nodes (auto-refreshes every 10 s) |
| **Memory** | Full-text search across episodic memory |
| **Status** | Gateway uptime, version, agent count, heartbeat log, manual trigger |

### Accessing from WSL2 or another device on the LAN

Set `bind_address: 0.0.0.0` in `~/.aura/config.yaml`, then open `http://<WSL-IP>:3000` from your Windows browser or any device on the same network. Find the WSL IP with:

```bash
ip addr show eth0 | grep 'inet '
```

---

## Self-Aware Learning

The agent builds and maintains persistent knowledge about you and itself over time — automatically.

### How it works

After every conversation reply, the agent runs two background LLM calls to extract new facts:

1. **User profile** — facts about you (preferences, projects, habits, tech setup, etc.)
2. **Self-knowledge** — what the agent learned about itself (corrections, lessons, what works for you)

Both are stored as plain Markdown files in `~/.aura/memory/<agent_ns>/`:

```
~/.aura/memory/personal/
├── user_profile.md       # everything the agent has learned about you
└── self_knowledge.md     # everything the agent has learned about itself
```

Both files are injected into every system prompt, so the agent always has full context about you from the very first message of a new session.

### Explicit memory tools

You can also tell the agent directly what to remember:

| What you say | What happens |
|---|---|
| "Remember that I prefer dark mode" | Saves to `user_profile.md` immediately |
| "Remember you should always give me code examples" | Saves to `self_knowledge.md` |
| "Consolidate your memory" | Deduplicates and reorganises both profile files |

The agent also uses these tools proactively when it recognises something worth saving.

### Example user profile (after a few chats)

```markdown
# User Profile

<!-- 2026-02-28 -->
- Uses WSL2 on Windows for development
- Working on a self-hosted AI gateway project
- Prefers concise, direct responses with no filler
- Primary language is English
- Telegram ID for personal notifications: 6665002430

<!-- 2026-03-01 -->
- Has another PC on the LAN for running additional gateway instances
- Prefers dark-themed UIs
```

---

## Testing the connection

### Browser dashboard

Open `http://localhost:3000` in your browser. No additional setup needed.

### ANP hardware node

```bash
npx wscat -c ws://localhost:8765/anp
# Authenticate:
{"anp":"1.0","type":"hello","node_id":"test_01","token":"sk-aura-test-token-01","caps":["text_in","text_out"],"meta":{}}
# After WELCOME, send an utterance:
{"type":"event","event":"utterance","node_id":"test_01","session_id":"s1","ts":0,"payload":{"text":"what time is it","routing_hint":"simple"}}
```

The test node token `sk-aura-test-token-01` is pre-configured in `~/.aura/nodes.yaml`.

### REST API

```bash
curl http://localhost:3002/api/health
curl http://localhost:3002/api/agents
curl http://localhost:3002/api/skills
curl -X POST http://localhost:3002/api/heartbeat/run
```

---

## Agents

Agents are defined in `~/.aura/agents.yaml`. Each agent has:
- A **persona** (system prompt)
- A list of **channels** it owns (by node_id prefix or exact match)
- A list of **skills** it can use
- An **LLM tier** (simple / complex / vision / creative / offline)
- A **memory namespace** (isolated from other agents)

**Resolution order:** exact node_id → prefix match → `default` agent.

Example — add a new agent:
```yaml
agents:
  - id: work
    name: "AURA Work"
    persona: "You are a focused work assistant. Be concise and structured."
    channels:
      - slack_work_dm
    skills:
      - web_search
      - notion
      - webhooks
    llm_tier: complex
    memory_ns: work
```

---

## Skills

All 11 built-in skills are in `~/.aura/skills/`. Each skill is a YAML definition + TypeScript executor.

| Skill | Tools | Env vars needed |
|---|---|---|
| `web_search` | `search` | None (DuckDuckGo free); `SERPAPI_KEY` optional |
| `reminders` | `set_reminder`, `list_reminders`, `cancel_reminder` | None |
| `notion` | `notion_search`, `notion_get_page`, `notion_create_page` … | `NOTION_API_KEY` |
| `spotify` | `spotify_play`, `spotify_pause`, `spotify_search` … | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| `apple_notes` | `notes_list`, `notes_read`, `notes_create` … | None (macOS only) |
| `twitter` | `twitter_post`, `twitter_search` … | `TWITTER_API_KEY` + 3 more |
| `webhooks` | `webhook_send`, `webhook_list_received` | None |
| `whoop` | `whoop_recovery`, `whoop_sleep`, `whoop_strain` | `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` |
| `home_assistant` | `ha_get_state`, `ha_call_service`, `ha_list_entities` | `HA_URL`, `HA_TOKEN` |
| `google_calendar` | `calendar_list_events`, `calendar_create_event` … | `GOOGLE_OAUTH_CREDENTIALS` |
| `body_control` | `speak`, `set_led`, `alert` | None (uses ANP) |
| `filesystem` | `workspace_read`, `workspace_write`, `workspace_list`, `workspace_delete`, `workspace_mkdir`, `workspace_move`, `workspace_info` | None |

### Agent workspace

The agent has a sandboxed workspace at `~/.aura/workspace/` — a directory it can freely read, write, and organise without any restrictions, but strictly confined to that path. Path traversal attempts, null bytes in paths, and writes exceeding 10 MB are all blocked at the security layer. Files are written with mode `0644`; no executable permissions are granted.

Add `filesystem` to a skill list in `agents.yaml` to enable it. See [`docs/workspace.md`](docs/workspace.md) for the full reference.

### Self-improving skills

Ask the agent to create a new skill in plain English:

```
"Create a skill that fetches my current public IP address"
```

The agent will:
1. Generate YAML + TypeScript using the LLM
2. Validate the TypeScript (`tsc --noEmit --strict`)
3. Install it to `~/.aura/skills/` — live without restart
4. Tag it `source: self_written`

---

## Heartbeat

The heartbeat runs automatically every 30 minutes (configurable). It reads `~/.aura/HEARTBEAT.md` and decides what to do — morning briefing, reminders, nightly summary, or nothing.

**Silent rule:** if nothing applies, the LLM returns `HEARTBEAT_OK` and no messages are sent.

**Proactive tools** available during heartbeat:
- `send_message(node_id, text)` — send to a specific user/device (max 10 per run)
- `send_to_agent_channels(agent_id, text)` — broadcast to all of an agent's channels

Trigger a manual heartbeat run:
```bash
curl -X POST http://localhost:3002/api/heartbeat/run
curl http://localhost:3002/api/heartbeat/log
```

---

## REST API reference

Base URL: `http://127.0.0.1:3002`

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Status, uptime, connected nodes |
| GET | `/api/nodes` | All connected ANP nodes |
| POST | `/api/nodes/:id/command` | Send command to a node |
| POST | `/api/nodes/:id/rotate-token` | Generate new token |
| GET | `/api/agents` | All loaded agents |
| GET | `/api/agents/:id/memory/search?q=` | FTS5 memory search |
| GET | `/api/agents/:id/memory/:date` | Episodic memory for a date |
| DELETE | `/api/agents/:id/memory/:date` | Delete episodic entry |
| GET | `/api/skills` | All loaded skills |
| POST | `/api/skills/:name/toggle` | Enable / disable a skill |
| GET | `/api/canvas` | Current canvas blocks |
| DELETE | `/api/canvas` | Clear canvas |
| POST | `/api/heartbeat/run` | Trigger heartbeat manually |
| GET | `/api/heartbeat/log` | Last 50 heartbeat run logs |
| GET | `/api/webhooks/:key` | Received inbound webhook payloads |
| DELETE | `/api/webhooks/:key` | Clear stored payloads |
| POST | `/webhook/:key` | Inbound webhook receiver (Zapier / n8n) |

---

## Live Canvas

The Canvas is a real-time whiteboard synced over WebSocket. Connect at `ws://127.0.0.1:3001/canvas`. On connect you receive the full current state. Subsequent messages are incremental events (`append`, `update`, `delete`, `clear`).

State persists to `~/.aura/memory/canvas.json` and restores on restart.

The browser dashboard includes a Canvas toggle button in the Chat panel header — click it to open the canvas as a side panel alongside the conversation.

---

## Security notes

- All servers bind to `127.0.0.1` by default — change `bind_address` in `config.yaml` for LAN access
- Remote access recommended via **Tailscale** (zero open firewall ports)
- Telegram channel enforces a per-bot `allowed_ids` whitelist — unknown IDs are silently dropped
- Token format: `sk-aura-` + 64 hex characters (`crypto.randomBytes`)
- Never commit `.env` or `nodes.yaml` — both are in `.gitignore`
- Self-written skills cannot call `shell` or `create_skill` tools
- Tool call loop is hard-capped at 5 iterations per utterance

---

## Project structure

```
aura-gateway/
├── agent.cjs                  # Node version gate (works on any Node version)
├── agent.js                   # CLI: onboard | --daemon | status | stop | logs | uninstall
├── _agent.js                  # ESM entry point (loaded by agent.cjs after version check)
├── default-skills/            # Bundled skill files — copied to ~/.aura/skills/ by onboard
├── src/
│   ├── server.ts              # Main entry point
│   ├── anp/                   # ANP WebSocket server + auth
│   ├── llm/                   # LLM router + 4 adapters
│   ├── agents/                # Agent registry + resolver
│   ├── memory/
│   │   ├── short_term.ts      # Per-session RAM ring buffer
│   │   ├── episodic.ts        # Daily .md files per agent namespace
│   │   ├── semantic.ts        # SQLite FTS5 search + reminders + webhooks
│   │   ├── profile.ts         # Persistent user_profile.md + self_knowledge.md
│   │   ├── extractor.ts       # Background LLM fact extraction after each reply
│   │   └── manager.ts         # Unified facade for all memory tiers
│   ├── skills/                # Skills engine + self-write
│   ├── channels/
│   │   ├── webchat.ts         # HTTP + WebSocket server — serves the browser dashboard
│   │   ├── webchat.html       # Full dashboard SPA (Chat / Skills / Nodes / Memory / Status)
│   │   └── …                  # Other channel adapters
│   ├── scheduler/             # Heartbeat + reminders + proactive
│   ├── canvas/                # Canvas renderer + WebSocket server
│   ├── voice/                 # ElevenLabs TTS + Whisper STT
│   ├── api/                   # REST API
│   ├── config/                # Config loader + types
│   └── types/                 # Module declarations
├── tests/
├── package.json
├── tsconfig.json
└── .env.example
```

Runtime files created by the wizard (not in the zip):

```
~/.aura/
├── config.yaml                # LLM routing, channels, voice, scheduler, security
├── agents.yaml                # Agent personas and channel assignments
├── nodes.yaml                 # Hardware node tokens
├── HEARTBEAT.md               # Autonomous heartbeat instructions
├── skills/                    # Skill YAML + TypeScript executors
├── memory/
│   ├── aura.db                # SQLite: FTS5 search, reminders, webhooks
│   ├── canvas.json            # Persisted canvas state
│   ├── personal/
│   │   ├── user_profile.md    # Learned facts about the user (grows over time)
│   │   ├── self_knowledge.md  # Learned facts about the agent itself
│   │   └── YYYY-MM-DD.md      # Daily episodic conversation summaries
│   └── …                      # Other agent namespaces
├── tokens/                    # OAuth tokens (WhatsApp session, Spotify …)
└── logs/
    └── aura.log               # Daemon log (created on first --daemon run)
```

---

## License

MIT
