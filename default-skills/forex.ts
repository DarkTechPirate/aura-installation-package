/**
 * Forex & Metals trading skill — OANDA broker.
 * Supports XAU/USD (gold), XAG/USD (silver), and all major/minor/exotic forex pairs.
 * Risk: 2% per trade, max 5% daily drawdown halt, max 8 concurrent trades.
 */

import { OandaClient, calcForexUnits, pipSize } from './forex_oanda.js';
import { analyze } from './trading_indicators.js';
import type { Bar } from './trading_indicators.js';

const MAX_TRADES     = 8;
const MAX_RISK_PCT   = 2;
const MAX_DAILY_LOSS = 5;

function client() { return new OandaClient(); }

function fmt(n: number, d = 5) { return n.toFixed(d); }

function defaultSL(price: number, side: 'buy' | 'sell', instrument: string): number {
  const inst = OandaClient.normalise(instrument);
  // Gold/Silver: 10-pip SL ($1.00); JPY pairs: 50 pips; others: 30 pips
  const slDistance = inst.startsWith('XAU') || inst.startsWith('XAG')
    ? price * 0.005          // 0.5% of price
    : inst.includes('JPY')
      ? 0.50
      : 0.0030;
  return parseFloat((side === 'buy' ? price - slDistance : price + slDistance).toFixed(5));
}

function defaultTP(entry: number, sl: number, side: 'buy' | 'sell'): number {
  const risk = Math.abs(entry - sl);
  return parseFloat((side === 'buy' ? entry + risk * 2 : entry - risk * 2).toFixed(5));
}

// ── Account & Positions ──────────────────────────────────────────────────────

export async function forex_account(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const oanda = client();
    const [acc, trades] = await Promise.all([oanda.getAccount(), oanda.getTrades()]);

    const dailyPL    = acc.unrealizedPL + acc.realizedPL;
    const isPractice = (process.env['OANDA_PRACTICE'] ?? 'true') !== 'false';

    return {
      mode:          isPractice ? 'PRACTICE ACCOUNT' : 'LIVE ACCOUNT',
      currency:      acc.currency,
      balance:       `${acc.currency} ${acc.balance.toFixed(2)}`,
      nav:           `${acc.currency} ${acc.nav.toFixed(2)}`,
      unrealised_pl: `${acc.unrealizedPL >= 0 ? '+' : ''}${acc.unrealizedPL.toFixed(2)}`,
      realised_pl:   `${acc.realizedPL >= 0 ? '+' : ''}${acc.realizedPL.toFixed(2)}`,
      margin_used:   `${acc.marginUsed.toFixed(2)}`,
      margin_avail:  `${acc.marginAvail.toFixed(2)}`,
      open_trades:   acc.openTradeCount,
      daily_pl_pct:  `${((dailyPL / acc.balance) * 100).toFixed(2)}%`,
      risk_rules:    `Max ${MAX_RISK_PCT}% per trade | Max ${MAX_TRADES} trades | Halt at -${MAX_DAILY_LOSS}% daily`,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_positions(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const oanda  = client();
    const trades = await oanda.getTrades();
    if (!trades.length) return { message: 'No open trades.' };

    const totalPL = trades.reduce((s, t) => s + t.unrealizedPL, 0);
    return {
      count:  trades.length,
      trades: trades.map(t => ({
        id:          t.id,
        instrument:  t.instrument,
        direction:   t.units > 0 ? 'LONG' : 'SHORT',
        units:       Math.abs(t.units),
        entry_price: fmt(t.price),
        stop_loss:   t.stopLossOrder   ? fmt(t.stopLossOrder.price)   : 'none',
        take_profit: t.takeProfitOrder ? fmt(t.takeProfitOrder.price) : 'none',
        unrealised_pl: `${t.unrealizedPL >= 0 ? '+' : ''}${t.unrealizedPL.toFixed(2)}`,
        opened:      new Date(t.openTime).toLocaleString(),
      })),
      total_pl: `${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}`,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_orders(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const oanda  = client();
    const orders = await oanda.getOrders();
    if (!orders.length) return { message: 'No pending orders.' };
    return {
      count:  orders.length,
      orders: orders.map(o => ({
        id:         o.id,
        instrument: o.instrument,
        type:       o.type,
        direction:  o.units > 0 ? 'LONG' : 'SHORT',
        units:      Math.abs(o.units),
        price:      o.price ? fmt(o.price) : 'market',
        state:      o.state,
      })),
    };
  } catch (e) { return { error: String(e) }; }
}

// ── Market Data ──────────────────────────────────────────────────────────────

export async function forex_quote(args: { instrument: string }, _ctx: unknown): Promise<unknown> {
  try {
    const oanda = client();
    const p     = await oanda.getPrice(args.instrument);
    const pip   = pipSize(args.instrument);
    const spreadPips = p.spread / pip;
    return {
      instrument:  p.instrument,
      bid:         fmt(p.bid),
      ask:         fmt(p.ask),
      mid:         fmt(p.mid),
      spread:      `${spreadPips.toFixed(1)} pips (${fmt(p.spread, 5)})`,
      tradeable:   p.tradeable,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_analysis(args: { instrument: string; granularity?: string }, _ctx: unknown): Promise<unknown> {
  try {
    const oanda  = client();
    const gran   = args.granularity ?? 'D';
    const candles = await oanda.getCandles(args.instrument, gran, 100);

    if (candles.length < 30) return { error: 'Not enough candles for analysis (need 30+)' };

    const bars: Bar[] = candles.map(c => ({
      t: c.time,
      o: parseFloat(c.mid.o),
      h: parseFloat(c.mid.h),
      l: parseFloat(c.mid.l),
      c: parseFloat(c.mid.c),
      v: c.volume,
    }));

    const inst   = OandaClient.normalise(args.instrument);
    const result = analyze(bars, inst);
    const pip    = pipSize(inst);
    const price  = await oanda.getPrice(inst).catch(() => null);

    return {
      instrument:  inst,
      granularity: gran,
      price:       price ? fmt(price.mid) : fmt(result.price),
      change:      `${result.change1d.toFixed(2)}%`,
      trend:       result.trend,
      signal:      result.signal,
      score:       `${result.score}/100`,
      indicators: {
        ema20:       fmt(result.ema20),
        ema50:       fmt(result.ema50),
        rsi14:       result.rsi14.toFixed(1),
        macd_hist:   result.macd.histogram.toFixed(5),
        bb_upper:    fmt(result.bb.upper),
        bb_lower:    fmt(result.bb.lower),
        bb_position: `${(result.bb.pct * 100).toFixed(0)}%`,
        pip_size:    String(pip),
        vol_ratio:   `${result.volumeRatio.toFixed(2)}x avg`,
      },
      reasons: result.reasons,
    };
  } catch (e) { return { error: String(e) }; }
}

// ── Trade Execution ──────────────────────────────────────────────────────────

export async function forex_trade(
  args: {
    instrument:  string;
    side:        'buy' | 'sell';
    units?:      number;
    type?:       'market' | 'limit';
    limit_price?: number;
    stop_loss?:  number;
    take_profit?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const oanda = client();
    const inst  = OandaClient.normalise(args.instrument);
    const side  = args.side;

    const [acc, trades, price] = await Promise.all([
      oanda.getAccount(),
      oanda.getTrades(),
      oanda.getPrice(inst),
    ]);

    // Daily loss guard
    const dailyPnlPct = ((acc.unrealizedPL + acc.realizedPL) / acc.balance) * 100;
    if (dailyPnlPct <= -MAX_DAILY_LOSS) {
      return { approved: false, reason: `Daily loss limit reached (${dailyPnlPct.toFixed(2)}%). Trading halted for today.` };
    }

    // Max trades guard
    if (trades.length >= MAX_TRADES) {
      return { approved: false, reason: `Maximum ${MAX_TRADES} concurrent trades reached. Close a trade first.` };
    }

    const entryPrice = side === 'buy' ? price.ask : price.bid;
    const sl  = args.stop_loss   ?? defaultSL(entryPrice, side, inst);
    const tp  = args.take_profit ?? defaultTP(entryPrice, sl, side);
    const units = args.units ?? calcForexUnits(acc.balance, entryPrice, sl, MAX_RISK_PCT);

    if (units <= 0) return { error: 'Position size is 0 — check balance and stop-loss distance.' };

    const pip        = pipSize(inst);
    const slPips     = Math.abs(entryPrice - sl) / pip;
    const tpPips     = Math.abs(entryPrice - tp) / pip;
    const maxRiskAmt = acc.balance * (MAX_RISK_PCT / 100);

    const result = args.type === 'limit' && args.limit_price
      ? await oanda.placeLimitOrder({ instrument: inst, units: side === 'buy' ? units : -units, price: args.limit_price, stopLoss: sl, takeProfit: tp })
      : await oanda.placeMarketOrder({ instrument: inst, units: side === 'buy' ? units : -units, stopLoss: sl, takeProfit: tp });

    return {
      approved:    true,
      instrument:  inst,
      direction:   side.toUpperCase(),
      units,
      entry_price: fmt(entryPrice),
      stop_loss:   `${fmt(sl)} (${slPips.toFixed(1)} pips)`,
      take_profit: `${fmt(tp)} (${tpPips.toFixed(1)} pips)`,
      rr_ratio:    `1:${(tpPips / slPips).toFixed(1)}`,
      max_risk:    `${acc.currency} ${maxRiskAmt.toFixed(2)} (${MAX_RISK_PCT}% of balance)`,
      order_id:    result.orderId,
      trade_id:    result.tradeId,
      fill_price:  result.price ? fmt(result.price) : 'pending',
      daily_pl:    `${dailyPnlPct.toFixed(2)}%`,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_close(
  args: { trade_id: string; units?: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const oanda  = client();
    const trades = await oanda.getTrades();
    const trade  = trades.find(t => t.id === args.trade_id);

    await oanda.closeTrade(args.trade_id, args.units);

    return {
      trade_id:    args.trade_id,
      instrument:  trade?.instrument ?? 'unknown',
      units_closed: args.units ?? 'ALL',
      realised_pl: trade ? `${trade.unrealizedPL >= 0 ? '+' : ''}${trade.unrealizedPL.toFixed(2)}` : 'unknown',
      status:      'Closed',
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_update_sltp(
  args: { trade_id: string; stop_loss?: number; take_profit?: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const oanda = client();
    if (!args.stop_loss && !args.take_profit) return { error: 'Provide stop_loss and/or take_profit.' };
    await oanda.updateTradeSLTP(args.trade_id, args.stop_loss, args.take_profit);
    return {
      trade_id:    args.trade_id,
      stop_loss:   args.stop_loss   ? fmt(args.stop_loss)   : 'unchanged',
      take_profit: args.take_profit ? fmt(args.take_profit) : 'unchanged',
      status:      'Updated',
    };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_cancel(args: { order_id: string }, _ctx: unknown): Promise<unknown> {
  try {
    const oanda = client();
    await oanda.cancelOrder(args.order_id);
    return { order_id: args.order_id, status: 'Cancelled' };
  } catch (e) { return { error: String(e) }; }
}

export async function forex_scan(
  args: { instruments: string[] },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const oanda = client();
    const results = await Promise.all(
      args.instruments.map(async (sym) => {
        try {
          const candles = await oanda.getCandles(sym, 'D', 100);
          if (candles.length < 30) return { instrument: sym, error: 'Not enough data' };
          const bars: Bar[] = candles.map(c => ({
            t: c.time, o: parseFloat(c.mid.o), h: parseFloat(c.mid.h),
            l: parseFloat(c.mid.l), c: parseFloat(c.mid.c), v: c.volume,
          }));
          return analyze(bars, OandaClient.normalise(sym));
        } catch (e) { return { instrument: sym, error: String(e) }; }
      })
    );

    const valid = results
      .filter(r => !('error' in r))
      .sort((a, b) => (b as { score: number }).score - (a as { score: number }).score);

    return {
      scanned:     args.instruments.length,
      buy_signals: valid.filter(r => (r as { signal: string }).signal === 'buy').length,
      rankings:    valid.map(r => {
        const v = r as ReturnType<typeof analyze>;
        return {
          instrument: v.symbol,
          signal:     v.signal.toUpperCase(),
          score:      `${v.score}/100`,
          trend:      v.trend,
          rsi14:      v.rsi14.toFixed(1),
          reasons:    v.reasons.slice(0, 2),
        };
      }),
      errors: results.filter(r => 'error' in r),
    };
  } catch (e) { return { error: String(e) }; }
}
