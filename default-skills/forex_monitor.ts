/**
 * Forex trade monitor — runs during heartbeat to alert on open OANDA positions.
 * Checks: SL danger zone, breakeven opportunity, large loss alerts, TP proximity.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { OandaClient, pipSize } from './forex_oanda.js';

const CONFIG_PATH   = path.join(os.homedir(), '.aura', 'forex_monitor_config.json');
const HEARTBEAT_MD  = path.join(os.homedir(), '.aura', 'HEARTBEAT.md');

const SECTION_START = '<!-- forex-monitor-start -->';
const SECTION_END   = '<!-- forex-monitor-end -->';

const HEARTBEAT_INSTRUCTIONS = `${SECTION_START}
## Forex Trade Monitor (Active)
On every heartbeat:
1. Call \`forex_monitor_check\` — it scans all open OANDA trades and returns alerts.
2. If result.alerts has items, call \`send_message\` to the result.node_id with a clear summary of each alert.
3. If result.alerts is empty, do nothing — respond HEARTBEAT_OK.
${SECTION_END}`;

interface MonitorConfig {
  enabled:        boolean;
  node_id:        string;   // e.g. telegram_6665002430
  danger_pips:    number;   // alert if price this close to SL
  breakeven_pct:  number;   // suggest breakeven when this % of the way to TP
  loss_alert_pct: number;   // alert if trade unrealised loss > this % of balance
  tp_alert_pct:   number;   // alert if trade is this % of the way to TP (near exit)
}

function readConfig(): MonitorConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as MonitorConfig; }
  catch { return null; }
}

function writeConfig(cfg: MonitorConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function updateHeartbeatMd(add: boolean): void {
  let content = fs.existsSync(HEARTBEAT_MD)
    ? fs.readFileSync(HEARTBEAT_MD, 'utf8')
    : '';

  // Strip any existing monitor section
  const s = content.indexOf(SECTION_START);
  const e = content.indexOf(SECTION_END);
  if (s !== -1 && e !== -1) {
    content = (content.slice(0, s) + content.slice(e + SECTION_END.length)).replace(/\n{3,}/g, '\n\n');
  }

  if (add) content = content.trimEnd() + '\n\n' + HEARTBEAT_INSTRUCTIONS + '\n';

  fs.writeFileSync(HEARTBEAT_MD, content.trim() + '\n', 'utf8');
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function forex_monitor_start(
  args: {
    node_id:        string;
    danger_pips?:   number;
    breakeven_pct?: number;
    loss_alert_pct?: number;
    tp_alert_pct?:  number;
  },
  _ctx: unknown,
): Promise<unknown> {
  if (!args.node_id) throw new Error('node_id is required (e.g. telegram_6665002430)');

  const cfg: MonitorConfig = {
    enabled:        true,
    node_id:        args.node_id,
    danger_pips:    args.danger_pips    ?? 15,
    breakeven_pct:  args.breakeven_pct  ?? 50,
    loss_alert_pct: args.loss_alert_pct ?? 1.0,
    tp_alert_pct:   args.tp_alert_pct   ?? 80,
  };

  writeConfig(cfg);
  updateHeartbeatMd(true);

  return {
    started: true,
    config:  cfg,
    note:    `Monitoring active. Gary will check all open trades on every heartbeat and alert ${cfg.node_id}.`,
    alerts_for: [
      `Price within ${cfg.danger_pips} pips of stop-loss`,
      `Trade ${cfg.breakeven_pct}%+ of the way to TP (move SL to breakeven)`,
      `Trade ${cfg.tp_alert_pct}%+ of the way to TP (consider taking profit)`,
      `Unrealised loss > ${cfg.loss_alert_pct}% of account balance`,
    ],
  };
}

export async function forex_monitor_stop(_args: unknown, _ctx: unknown): Promise<unknown> {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  updateHeartbeatMd(false);
  return { stopped: true, note: 'Forex monitoring disabled. HEARTBEAT.md updated.' };
}

export async function forex_monitor_status(_args: unknown, _ctx: unknown): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg) return { enabled: false, message: 'No active monitor. Call forex_monitor_start to enable.' };
  return { enabled: true, config: cfg };
}

export async function forex_monitor_check(_args: unknown, _ctx: unknown): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg?.enabled) return { enabled: false, alerts: [], message: 'Monitor not configured.' };

  const oanda = new OandaClient();
  const [trades, acc] = await Promise.all([oanda.getTrades(), oanda.getAccount()]);

  if (!trades.length) {
    return { enabled: true, alerts: [], node_id: cfg.node_id, open_trades: 0, summary: 'No open trades.' };
  }

  // Fetch live prices for all open instruments in parallel
  const instruments = [...new Set(trades.map(t => t.instrument))];
  const prices: Record<string, number> = {};
  await Promise.all(instruments.map(async inst => {
    try { prices[inst] = (await oanda.getPrice(inst)).mid; } catch { /* skip */ }
  }));

  const alerts: string[] = [];

  for (const trade of trades) {
    const livePrice = prices[trade.instrument] ?? trade.price;
    const pip       = pipSize(trade.instrument);
    const isLong    = trade.units > 0;
    const dir       = isLong ? 'LONG' : 'SHORT';
    const inst      = trade.instrument;
    const id        = trade.id;
    const plPct     = (trade.unrealizedPL / acc.balance) * 100;

    // 1. Danger zone — price is too close to stop-loss
    if (trade.stopLossOrder) {
      const sl        = trade.stopLossOrder.price;
      const pipsToSL  = Math.abs(livePrice - sl) / pip;
      if (pipsToSL <= cfg.danger_pips) {
        alerts.push(
          `DANGER | ${inst} ${dir} #${id}: only ${pipsToSL.toFixed(1)} pips from SL (${sl.toFixed(5)}). Current price: ${livePrice.toFixed(5)}`
        );
      }
    }

    // 2. Breakeven & TP proximity
    if (trade.stopLossOrder && trade.takeProfitOrder) {
      const sl       = trade.stopLossOrder.price;
      const tp       = trade.takeProfitOrder.price;
      const totalPips = Math.abs(tp - trade.price) / pip;
      const donePips  = isLong
        ? (livePrice - trade.price) / pip
        : (trade.price - livePrice) / pip;
      const pctDone   = totalPips > 0 ? (donePips / totalPips) * 100 : 0;

      // SL already at or past breakeven?
      const slBreakevenPips = isLong
        ? (sl - trade.price) / pip
        : (trade.price - sl) / pip;
      const slAtBreakeven = slBreakevenPips >= 0;

      if (pctDone >= cfg.tp_alert_pct) {
        alerts.push(
          `NEAR TP | ${inst} ${dir} #${id}: ${pctDone.toFixed(0)}% of the way to TP (${donePips.toFixed(1)} pips profit). Consider taking partial profit.`
        );
      } else if (pctDone >= cfg.breakeven_pct && !slAtBreakeven) {
        alerts.push(
          `BREAKEVEN | ${inst} ${dir} #${id}: ${pctDone.toFixed(0)}% to TP. Move SL to entry (${trade.price.toFixed(5)}) to lock in breakeven.`
        );
      }
    }

    // 3. Large loss alert
    if (plPct <= -cfg.loss_alert_pct) {
      alerts.push(
        `LOSS | ${inst} ${dir} #${id}: down ${trade.unrealizedPL.toFixed(2)} ${acc.currency} (${plPct.toFixed(2)}% of balance). Check if SL is correct.`
      );
    }
  }

  return {
    enabled:     true,
    node_id:     cfg.node_id,
    open_trades: trades.length,
    alerts,
    summary:     alerts.length > 0
      ? `${alerts.length} alert(s) need attention`
      : 'All trades healthy',
    checked_at:  new Date().toISOString(),
  };
}
