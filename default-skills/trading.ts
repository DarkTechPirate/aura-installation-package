/**
 * Trading skill — AURA can analyze markets, place orders, and manage positions.
 * Broker: Alpaca Markets (paper trading by default).
 * Risk: 2% per trade, 5 max positions, 5% daily loss halt.
 */

import { AlpacaClient } from './trading_alpaca.js';
import { analyze }      from './trading_indicators.js';
import {
  calcPositionSize, defaultStopPrice, defaultTakeProfit,
  preFlightCheck, riskSummary, RISK_RULES,
} from './trading_risk.js';

function client() { return new AlpacaClient(); }

/** Score news headlines with keyword-based sentiment — no external API needed. */
function scoreSentiment(headlines: string[]): { sentiment: 'positive' | 'negative' | 'neutral'; detail: string } {
  const POS = ['beats', 'beat', 'surges', 'rally', 'record', 'growth', 'upgrade', 'raised', 'strong', 'profit', 'gains', 'buyback', 'dividend', 'outperform', 'bullish'];
  const NEG = ['misses', 'miss', 'drops', 'falls', 'crash', 'loss', 'losses', 'downgrade', 'cut', 'cuts', 'warning', 'fraud', 'layoff', 'layoffs', 'recall', 'lawsuit', 'investigation', 'weak', 'bearish', 'concern'];
  let pos = 0, neg = 0;
  for (const h of headlines) {
    const lower = h.toLowerCase();
    pos += POS.filter(w => lower.includes(w)).length;
    neg += NEG.filter(w => lower.includes(w)).length;
  }
  const sentiment = pos > neg + 1 ? 'positive' : neg > pos + 1 ? 'negative' : 'neutral';
  return { sentiment, detail: `${pos} positive / ${neg} negative signals across ${headlines.length} headlines` };
}

// ── Market Data ──────────────────────────────────────────────────────────────

export async function get_quote(args: { symbol: string }, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca = client();
    const symbol = args.symbol.toUpperCase();
    const quote  = await alpaca.getQuote(symbol);
    return { symbol, ...quote, spread: (quote.ask - quote.bid).toFixed(4) };
  } catch (e) { return { error: String(e) }; }
}

export async function get_bars(
  args: { symbol: string; timeframe?: string; limit?: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca = client();
    const symbol = args.symbol.toUpperCase();
    const bars   = await alpaca.getBars(symbol, args.timeframe ?? '1Day', args.limit ?? 60);
    if (!bars.length) return { error: 'No bars returned' };
    const last = bars[bars.length - 1];
    return {
      symbol, timeframe: args.timeframe ?? '1Day',
      bars_count: bars.length,
      latest:  { open: last.o, high: last.h, low: last.l, close: last.c, volume: last.v, time: last.t },
      first_bar_time: bars[0].t,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function get_news(args: { symbol: string; limit?: number }, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca = client();
    const news   = await alpaca.getNews(args.symbol.toUpperCase(), args.limit ?? 5);
    if (!news.length) return { symbol: args.symbol, message: 'No recent news found.' };
    return { symbol: args.symbol, count: news.length, articles: news };
  } catch (e) { return { error: String(e) }; }
}

export async function technical_analysis(args: { symbol: string }, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca = client();
    const symbol = args.symbol.toUpperCase();
    const bars   = await alpaca.getBars(symbol, '1Day', 100);
    if (bars.length < 30) return { error: 'Not enough data for analysis (need 30+ days)' };
    const result = analyze(bars, symbol);
    return {
      symbol:       result.symbol,
      price:        result.price.toFixed(2),
      change_1d:    `${result.change1d.toFixed(2)}%`,
      trend:        result.trend,
      signal:       result.signal,
      score:        `${result.score}/100`,
      indicators: {
        ema20:      result.ema20.toFixed(2),
        ema50:      result.ema50.toFixed(2),
        rsi14:      result.rsi14.toFixed(1),
        macd_line:  result.macd.line.toFixed(4),
        macd_signal:result.macd.signal.toFixed(4),
        macd_hist:  result.macd.histogram.toFixed(4),
        bb_upper:   result.bb.upper.toFixed(2),
        bb_middle:  result.bb.middle.toFixed(2),
        bb_lower:   result.bb.lower.toFixed(2),
        bb_position:`${(result.bb.pct * 100).toFixed(0)}%`,
        volume:     result.volume.toLocaleString(),
        vol_ratio:  `${result.volumeRatio.toFixed(2)}x avg`,
      },
      reasons: result.reasons,
    };
  } catch (e) { return { error: String(e) }; }
}

// ── Account & Positions ──────────────────────────────────────────────────────

export async function get_account(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca    = client();
    const [account, positions] = await Promise.all([alpaca.getAccount(), alpaca.getPositions()]);
    const isPaper   = (process.env['ALPACA_PAPER'] ?? 'true') !== 'false';
    return {
      mode:    isPaper ? 'PAPER TRADING' : 'LIVE TRADING',
      summary: riskSummary(account, positions),
      account: {
        equity:        `$${account.equity.toFixed(2)}`,
        cash:          `$${account.cash.toFixed(2)}`,
        buying_power:  `$${account.buying_power.toFixed(2)}`,
        portfolio:     `$${account.portfolio_value.toFixed(2)}`,
      },
    };
  } catch (e) { return { error: String(e) }; }
}

export async function get_positions(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca    = client();
    const positions = await alpaca.getPositions();
    if (!positions.length) return { message: 'No open positions.' };
    return {
      count:     positions.length,
      positions: positions.map(p => ({
        symbol:        p.symbol,
        qty:           p.qty,
        side:          p.side,
        entry:         `$${p.avg_entry_price.toFixed(2)}`,
        current:       `$${p.current_price.toFixed(2)}`,
        market_value:  `$${p.market_value.toFixed(2)}`,
        unrealised_pl: `${p.unrealized_pl >= 0 ? '+' : ''}$${p.unrealized_pl.toFixed(2)} (${(p.unrealized_plpc * 100).toFixed(2)}%)`,
      })),
      total_pl: `$${positions.reduce((s, p) => s + p.unrealized_pl, 0).toFixed(2)}`,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function get_orders(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca = client();
    const orders = await alpaca.getOrders('open');
    if (!orders.length) return { message: 'No open orders.' };
    return {
      count:  orders.length,
      orders: orders.map(o => ({
        id:          o.id,
        symbol:      o.symbol,
        side:        o.side,
        type:        o.type,
        qty:         o.qty,
        filled:      o.filled_qty,
        status:      o.status,
        limit_price: o.limit_price ? `$${o.limit_price}` : null,
        stop_price:  o.stop_price  ? `$${o.stop_price}`  : null,
      })),
    };
  } catch (e) { return { error: String(e) }; }
}

// ── Trade Execution ──────────────────────────────────────────────────────────

export async function place_order(
  args: {
    symbol:      string;
    side:        'buy' | 'sell';
    qty?:        number;
    type?:       'market' | 'limit' | 'stop' | 'stop_limit';
    limit_price?: number;
    stop_loss?:  number;
    take_profit?: number;
  },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca    = client();
    const symbol    = args.symbol.toUpperCase();
    const side      = args.side;
    const orderType = args.type ?? 'market';

    const [account, positions, quote, newsData] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getQuote(symbol),
      alpaca.getNews(symbol, 5).catch(() => []),
    ]);

    // News sentiment check — block strongly negative buys / strongly positive sells
    const headlines = newsData.map(n => n.headline);
    const { sentiment, detail: sentimentDetail } = scoreSentiment(headlines);
    if (side === 'buy'  && sentiment === 'negative') {
      return { approved: false, reason: `Sentiment block: negative news detected before BUY. ${sentimentDetail}. Review news with get_news("${symbol}") before proceeding.` };
    }
    if (side === 'sell' && sentiment === 'positive') {
      return { approved: false, reason: `Sentiment block: positive news detected before SELL. ${sentimentDetail}. Review news with get_news("${symbol}") before proceeding.` };
    }

    const price     = quote.ask || quote.price;
    const stopLoss  = args.stop_loss  ?? defaultStopPrice(price, side);
    const takeProfit= args.take_profit ?? defaultTakeProfit(price, stopLoss, side);
    const qty       = args.qty ?? calcPositionSize(account.equity, price, stopLoss);

    if (qty <= 0) return { error: 'Position size calculated to 0. Check account equity and stop-loss distance.' };

    const risk = preFlightCheck(
      account, positions, symbol, side, qty, price,
      alpaca.isMarketOpen(), alpaca.isNearMarketBoundary(),
    );
    if (!risk.approved) return { approved: false, reason: risk.reason };

    const order = await alpaca.placeOrder({
      symbol, side, qty, type: orderType,
      limit_price:  args.limit_price,
      stop_loss:    stopLoss,
      take_profit:  takeProfit,
    });

    return {
      approved:     true,
      order_id:     order.id,
      symbol:       order.symbol,
      side:         order.side,
      qty:          order.qty,
      type:         order.type,
      status:       order.status,
      entry_price:  `~$${price.toFixed(2)}`,
      stop_loss:    `$${stopLoss.toFixed(2)}`,
      take_profit:  `$${takeProfit.toFixed(2)}`,
      max_risk:     `$${(qty * Math.abs(price - stopLoss)).toFixed(2)} (${RISK_RULES.MAX_RISK_PER_TRADE_PCT}% of equity)`,
      news_sentiment: sentiment,
      risk_check:   risk.reason,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function close_position(
  args: { symbol: string; qty?: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca   = client();
    const symbol   = args.symbol.toUpperCase();
    const positions = await alpaca.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) return { error: `No open position for ${symbol}.` };
    await alpaca.closePosition(symbol, args.qty);
    const closedQty = args.qty ?? pos.qty;
    const pnl       = (pos.unrealized_plpc * 100 * (closedQty / pos.qty));
    return {
      symbol,
      qty_closed:   closedQty,
      entry_price:  `$${pos.avg_entry_price.toFixed(2)}`,
      close_price:  `~$${pos.current_price.toFixed(2)}`,
      realised_pl:  `${pos.unrealized_pl >= 0 ? '+' : ''}$${(pos.unrealized_pl * closedQty / pos.qty).toFixed(2)}`,
      return_pct:   `${pnl.toFixed(2)}%`,
      status:       'Position closed',
    };
  } catch (e) { return { error: String(e) }; }
}

export async function cancel_order(args: { order_id: string }, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca = client();
    await alpaca.cancelOrder(args.order_id);
    return { order_id: args.order_id, status: 'cancelled' };
  } catch (e) { return { error: String(e) }; }
}

// ── Trade Management ─────────────────────────────────────────────────────────

export async function set_bracket(
  args: { symbol: string; stop_loss: number; take_profit: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca    = client();
    const symbol    = args.symbol.toUpperCase();
    const positions = await alpaca.getPositions();
    const pos       = positions.find(p => p.symbol === symbol);
    if (!pos) return { error: `No open position for ${symbol}.` };

    const exitSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';

    // Cancel any existing stop/limit orders for this symbol first
    const cancelled = await alpaca.cancelOrdersForSymbol(symbol);

    // Place OCO bracket — stop-loss and take-profit cancel each other when one fills
    const order = await alpaca.placeBracketOnPosition({
      symbol,
      side:        exitSide,
      qty:         pos.qty,
      stop_loss:   args.stop_loss,
      take_profit: args.take_profit,
    });

    const riskDist   = Math.abs(pos.avg_entry_price - args.stop_loss);
    const rewardDist = Math.abs(args.take_profit - pos.avg_entry_price);

    return {
      symbol,
      position_side:  pos.side,
      qty:            pos.qty,
      entry_price:    `$${pos.avg_entry_price.toFixed(2)}`,
      stop_loss:      `$${args.stop_loss.toFixed(2)}`,
      take_profit:    `$${args.take_profit.toFixed(2)}`,
      rr_ratio:       `1:${(rewardDist / riskDist).toFixed(1)}`,
      order_id:       order.id,
      cancelled_prev: cancelled,
      note:           'OCO bracket placed — stop-loss and take-profit will cancel each other on fill.',
    };
  } catch (e) { return { error: String(e) }; }
}

export async function trailing_stop(
  args: { symbol: string; trail_pct: number },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca    = client();
    const symbol    = args.symbol.toUpperCase();
    const positions = await alpaca.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) return { error: `No open position for ${symbol}.` };

    const price     = pos.current_price;
    const trailAmt  = price * (args.trail_pct / 100);
    const stopPrice = pos.side === 'long'
      ? parseFloat((price - trailAmt).toFixed(2))
      : parseFloat((price + trailAmt).toFixed(2));

    // Place a stop order for the trailing exit
    const order = await alpaca.placeOrder({
      symbol, side: pos.side === 'long' ? 'sell' : 'buy',
      qty: pos.qty, type: 'stop', stop_price: stopPrice,
    });

    return {
      symbol, trail_pct: `${args.trail_pct}%`,
      current_price: `$${price.toFixed(2)}`,
      stop_placed_at: `$${stopPrice.toFixed(2)}`,
      order_id: order.id,
      note: 'Stop order placed. Update manually as price moves or call again to refresh.',
    };
  } catch (e) { return { error: String(e) }; }
}

export async function scan_watchlist(
  args: { symbols: string[] },
  _ctx: unknown,
): Promise<unknown> {
  try {
    const alpaca  = client();
    const results = await Promise.all(
      args.symbols.map(async (sym) => {
        try {
          const bars = await alpaca.getBars(sym.toUpperCase(), '1Day', 100);
          if (bars.length < 30) return { symbol: sym, error: 'Not enough data' };
          return analyze(bars, sym.toUpperCase());
        } catch (e) {
          return { symbol: sym, error: String(e) };
        }
      })
    );

    const valid = results
      .filter(r => !('error' in r))
      .sort((a, b) => (b as { score: number }).score - (a as { score: number }).score);

    const errors = results.filter(r => 'error' in r);

    return {
      scanned:    args.symbols.length,
      buy_signals:  valid.filter(r => (r as { signal: string }).signal === 'buy').length,
      sell_signals: valid.filter(r => (r as { signal: string }).signal === 'sell').length,
      rankings: valid.map(r => {
        const v = r as ReturnType<typeof analyze>;
        return {
          symbol:  v.symbol,
          price:   `$${v.price.toFixed(2)}`,
          signal:  v.signal.toUpperCase(),
          score:   `${v.score}/100`,
          trend:   v.trend,
          rsi14:   v.rsi14.toFixed(1),
          reasons: v.reasons.slice(0, 2),
        };
      }),
      errors: errors.length ? errors : undefined,
    };
  } catch (e) { return { error: String(e) }; }
}

export async function monitor_positions(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    const alpaca    = client();
    const [positions, account] = await Promise.all([alpaca.getPositions(), alpaca.getAccount()]);

    if (!positions.length) return { message: 'No open positions to monitor.' };

    const alerts: string[] = [];
    const summary = await Promise.all(
      positions.map(async (pos) => {
        const bars = await alpaca.getBars(pos.symbol, '1Day', 60).catch(() => []);
        const ta   = bars.length >= 30 ? analyze(bars, pos.symbol) : null;
        const plPct = pos.unrealized_plpc * 100;
        const flags: string[] = [];

        if (plPct >= 5)  { flags.push('🟢 +5% profit — consider partial take-profit'); alerts.push(`${pos.symbol}: up ${plPct.toFixed(1)}%`); }
        if (plPct <= -3) { flags.push('🔴 -3% loss — check stop-loss'); alerts.push(`${pos.symbol}: down ${plPct.toFixed(1)}%`); }
        if (ta?.signal === 'sell' && pos.side === 'long') flags.push('⚠️ Technical sell signal — review position');
        if (ta?.signal === 'buy'  && pos.side === 'short') flags.push('⚠️ Technical buy signal — review short');

        return {
          symbol:       pos.symbol,
          side:         pos.side,
          qty:          pos.qty,
          entry:        `$${pos.avg_entry_price.toFixed(2)}`,
          current:      `$${pos.current_price.toFixed(2)}`,
          pl:           `${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%`,
          market_value: `$${pos.market_value.toFixed(2)}`,
          signal:       ta?.signal ?? 'unknown',
          score:        ta?.score ?? 'N/A',
          flags,
        };
      })
    );

    const dailyPnl    = account.equity - account.last_equity;
    const dailyPnlPct = (dailyPnl / account.last_equity) * 100;

    return {
      account_summary: riskSummary(account, positions),
      daily_pnl:       `${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)} (${dailyPnlPct.toFixed(2)}%)`,
      positions:       summary,
      alerts:          alerts.length ? alerts : ['All positions within normal range.'],
    };
  } catch (e) { return { error: String(e) }; }
}
