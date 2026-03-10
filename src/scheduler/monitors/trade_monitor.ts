/**
 * TradeMonitor — Pulse module for real-time forex trade monitoring.
 *
 * Checks all open positions every pulse tick against four conditions:
 *   1. SL danger     — price within sl_danger_pct % of stop-loss
 *   2. Breakeven opp — trade is breakeven_pct % of the way to TP
 *   3. Near TP       — trade is tp_near_pct % of the way to TP
 *   4. Large loss    — account unrealised loss exceeds loss_alert_pct %
 *
 * Each condition has a per-trade cooldown to prevent alert spam.
 * Register into Pulse: pulse.register(new TradeMonitor())
 */

import type { SkillsEngine } from '../../skills/engine.js';
import type { SkillContext }  from '../../skills/types.js';
import type { PulseMonitor, Alert } from '../pulse.js';
import { Cooldown }          from '../pulse.js';

export interface TradeMonitorConfig {
  /** Alert when price is within this % of SL (default 0.3%) */
  sl_danger_pct:   number;
  /** Alert when trade reaches this % progress toward TP (default 80%) */
  tp_near_pct:     number;
  /** Suggest breakeven at this % progress toward TP (default 50%) */
  breakeven_pct:   number;
  /** Alert when unrealised account loss exceeds this % of balance (default 1%) */
  loss_alert_pct:  number;
  /** Minutes between re-alerting the same condition on the same trade (default 15) */
  cooldown_min:    number;
}

const DEFAULTS: TradeMonitorConfig = {
  sl_danger_pct:   0.3,
  tp_near_pct:     80,
  breakeven_pct:   50,
  loss_alert_pct:  1.0,
  cooldown_min:    15,
};

const STUB_CTX: SkillContext = {
  node_id:    'pulse',
  session_id: 'pulse',
  agent_id:   'pulse',
  anp:        { sendCommand: () => {} },
  memory:     { search: async () => [] },
  channel:    { send: async () => {} },
  canvas:     { append: () => {}, clear: () => {} },
};

interface Trade {
  id:            string;
  instrument:    string;
  direction:     'LONG' | 'SHORT';
  entry_price:   string;
  stop_loss:     string;
  take_profit:   string;
  unrealised_pl: string;
}

export class TradeMonitor implements PulseMonitor {
  readonly name = 'trade_monitor';

  private readonly cfg:      TradeMonitorConfig;
  private readonly cooldown: Cooldown;

  constructor(cfg: Partial<TradeMonitorConfig> = {}) {
    this.cfg      = { ...DEFAULTS, ...cfg };
    this.cooldown = new Cooldown();
  }

  async check(skills: SkillsEngine): Promise<Alert[]> {
    const texts: string[] = [];

    await this.checkTrades(skills, texts);
    await this.checkAccountLoss(skills, texts);

    if (texts.length === 0) return [];

    // Build context once for all alerts fired in this tick
    const context = await this.buildContext(skills);
    return texts.map(text => ({ text, context }));
  }

  // ── Context builder — owned by this monitor ────────────────────────────────

  private async buildContext(skills: SkillsEngine): Promise<string> {
    const [positions, account] = await Promise.allSettled([
      skills.execute('forex_positions', {}, STUB_CTX),
      skills.execute('forex_account',   {}, STUB_CTX),
    ]);

    const parts: string[] = [];

    if (positions.status === 'fulfilled') {
      parts.push('### Open Positions', JSON.stringify(positions.value, null, 2));
    }
    if (account.status === 'fulfilled') {
      parts.push('### Account Snapshot', JSON.stringify(account.value, null, 2));
    }

    return parts.join('\n\n');
  }

  // ── Per-trade checks ────────────────────────────────────────────────────────

  private async checkTrades(skills: SkillsEngine, texts: string[]): Promise<void> {
    const positions = await skills.execute('forex_positions', {}, STUB_CTX) as
      { trades?: Trade[]; message?: string } | null;

    if (!positions?.trades?.length) return;

    // Fetch quotes for all instruments in parallel
    const instruments = [...new Set(positions.trades.map(t => t.instrument))];
    const quotePairs  = await Promise.all(
      instruments.map(inst =>
        skills.execute('forex_quote', { instrument: inst }, STUB_CTX)
          .then(q  => [inst, q  as { mid: string }] as const)
          .catch(() => [inst, null]                  as const),
      ),
    );
    const priceMap = new Map(quotePairs);

    for (const trade of positions.trades) {
      const quote = priceMap.get(trade.instrument);
      if (!quote?.mid) continue;

      const current = parseFloat(quote.mid);
      const entry   = parseFloat(trade.entry_price);
      const sl      = trade.stop_loss   !== 'none' ? parseFloat(trade.stop_loss)   : null;
      const tp      = trade.take_profit !== 'none' ? parseFloat(trade.take_profit) : null;
      const isLong  = trade.direction === 'LONG';

      // 1. SL danger zone
      if (sl !== null) {
        const distPct = (Math.abs(current - sl) / current) * 100;
        if (distPct < this.cfg.sl_danger_pct) {
          if (this.cooldown.allow(`sl_danger:${trade.id}`, this.cfg.cooldown_min)) {
            texts.push(
              `🚨 SL DANGER — ${trade.instrument} ${trade.direction}: ` +
              `price ${quote.mid} is ${distPct.toFixed(2)}% from stop-loss ${trade.stop_loss}. ` +
              `Unrealised P&L: ${trade.unrealised_pl}. Immediate attention needed.`,
            );
          }
        }
      }

      // 2. Breakeven + near-TP
      if (sl !== null && tp !== null) {
        const totalRange  = Math.abs(tp - entry);
        const currentGain = isLong ? current - entry : entry - current;
        const pctToTp     = totalRange > 0 ? (currentGain / totalRange) * 100 : 0;

        if (pctToTp >= this.cfg.tp_near_pct) {
          if (this.cooldown.allow(`near_tp:${trade.id}`, this.cfg.cooldown_min)) {
            texts.push(
              `🎯 NEAR TP — ${trade.instrument} ${trade.direction}: ` +
              `${pctToTp.toFixed(0)}% of the way to TP ${trade.take_profit}. ` +
              `Current price ${quote.mid}. Consider partial close or trailing stop.`,
            );
          }
        } else if (pctToTp >= this.cfg.breakeven_pct) {
          if (this.cooldown.allow(`breakeven:${trade.id}`, this.cfg.cooldown_min)) {
            texts.push(
              `💡 BREAKEVEN OPP — ${trade.instrument} ${trade.direction}: ` +
              `${pctToTp.toFixed(0)}% toward TP ${trade.take_profit}. ` +
              `Consider moving SL to entry ${trade.entry_price} for a risk-free trade.`,
            );
          }
        }
      }
    }
  }

  // ── Account-level large loss ────────────────────────────────────────────────

  private async checkAccountLoss(skills: SkillsEngine, texts: string[]): Promise<void> {
    const acc = await skills.execute('forex_account', {}, STUB_CTX) as
      { balance?: string; unrealised_pl?: string; currency?: string } | null;

    if (!acc?.balance || !acc?.unrealised_pl) return;

    const balance = parseFloat(acc.balance.replace(/[^0-9.-]/g, ''));
    const upl     = parseFloat(acc.unrealised_pl.replace(/[^0-9.-]/g, ''));
    if (balance <= 0 || upl >= 0) return;

    const lossPct = (Math.abs(upl) / balance) * 100;
    if (lossPct >= this.cfg.loss_alert_pct) {
      if (this.cooldown.allow('large_loss:account', this.cfg.cooldown_min)) {
        texts.push(
          `⚠️ LARGE LOSS — Account unrealised loss is ${lossPct.toFixed(2)}% of balance ` +
          `(${acc.unrealised_pl} ${acc.currency ?? ''}). Review open positions.`,
        );
      }
    }
  }
}
