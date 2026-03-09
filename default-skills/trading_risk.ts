/** Risk management — position sizing, pre-flight checks, daily loss guard. */

import type { AlpacaAccount, AlpacaPosition } from './trading_alpaca.js';

export const RISK_RULES = {
  MAX_RISK_PER_TRADE_PCT: 2,    // max 2% of equity per trade
  MAX_POSITIONS:          5,    // max concurrent open positions
  MAX_DAILY_LOSS_PCT:     5,    // halt trading if down 5% on the day
  MIN_MARKET_MINUTES:     5,    // don't trade within 5 min of open/close
  MIN_SCORE_TO_BUY:       60,   // indicator score threshold for buy signals
};

export interface RiskCheckResult {
  approved: boolean;
  reason:   string;
  qty?:     number;  // suggested position size
}

/**
 * Calculate number of shares to buy given a risk amount and stop-loss distance.
 * Risk = qty × |entry - stop|  →  qty = riskAmount / |entry - stop|
 */
export function calcPositionSize(
  equity:     number,
  entryPrice: number,
  stopPrice:  number,
  riskPct     = RISK_RULES.MAX_RISK_PER_TRADE_PCT,
): number {
  const riskAmount   = equity * (riskPct / 100);
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (riskPerShare <= 0) return 0;
  return Math.max(1, Math.floor(riskAmount / riskPerShare));
}

/**
 * Default stop-loss price: 2% below entry for longs, 2% above for shorts.
 */
export function defaultStopPrice(entryPrice: number, side: 'buy' | 'sell'): number {
  return side === 'buy'
    ? parseFloat((entryPrice * 0.98).toFixed(2))
    : parseFloat((entryPrice * 1.02).toFixed(2));
}

/**
 * Default take-profit: 2:1 reward/risk ratio.
 */
export function defaultTakeProfit(entryPrice: number, stopPrice: number, side: 'buy' | 'sell'): number {
  const risk = Math.abs(entryPrice - stopPrice);
  return side === 'buy'
    ? parseFloat((entryPrice + risk * 2).toFixed(2))
    : parseFloat((entryPrice - risk * 2).toFixed(2));
}

/**
 * Full pre-flight risk check before placing an order.
 */
export function preFlightCheck(
  account:   AlpacaAccount,
  positions: AlpacaPosition[],
  symbol:    string,
  side:      'buy' | 'sell',
  qty:       number,
  price:     number,
  isMarketOpen:       boolean,
  nearMarketBoundary: boolean = false,
): RiskCheckResult {
  // Market hours check
  if (!isMarketOpen) {
    return { approved: false, reason: 'Market is closed. Orders will be queued for next open.' };
  }

  // 2-minute market open/close buffer — spreads are wide, fills are unpredictable
  if (nearMarketBoundary) {
    return { approved: false, reason: 'Within 2 minutes of market open or close. Spreads are wide — wait for stable conditions.' };
  }

  // Daily loss check
  const dailyPnl    = account.equity - account.last_equity;
  const dailyPnlPct = (dailyPnl / account.last_equity) * 100;
  if (dailyPnlPct <= -RISK_RULES.MAX_DAILY_LOSS_PCT) {
    return {
      approved: false,
      reason: `Daily loss limit reached (${dailyPnlPct.toFixed(2)}%). Trading halted for today to protect capital.`,
    };
  }

  // Position count check (only for new positions)
  const existing = positions.find(p => p.symbol === symbol);
  if (!existing && positions.length >= RISK_RULES.MAX_POSITIONS) {
    return {
      approved: false,
      reason: `Maximum ${RISK_RULES.MAX_POSITIONS} concurrent positions reached. Close an existing position first.`,
    };
  }

  // Buying power check
  const orderValue = qty * price;
  if (side === 'buy' && orderValue > account.buying_power) {
    return {
      approved: false,
      reason: `Insufficient buying power. Order value $${orderValue.toFixed(2)} exceeds available $${account.buying_power.toFixed(2)}.`,
    };
  }

  // Position size sanity — warn if > 2% risk assumed
  const maxOrderValue = account.equity * 0.20; // hard cap: no single position > 20% of equity
  if (orderValue > maxOrderValue) {
    return {
      approved: false,
      reason: `Order value $${orderValue.toFixed(2)} exceeds 20% of equity ($${maxOrderValue.toFixed(2)}). Reduce position size.`,
    };
  }

  return {
    approved: true,
    reason:   `Risk check passed. Order value: $${orderValue.toFixed(2)} | Daily P&L: ${dailyPnlPct.toFixed(2)}% | Open positions: ${positions.length}/${RISK_RULES.MAX_POSITIONS}`,
    qty,
  };
}

/**
 * Format a risk summary string for display.
 */
export function riskSummary(account: AlpacaAccount, positions: AlpacaPosition[]): string {
  const dailyPnl    = account.equity - account.last_equity;
  const dailyPnlPct = (dailyPnl / account.last_equity) * 100;
  const totalUnrealised = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  return [
    `Equity: $${account.equity.toFixed(2)}`,
    `Cash: $${account.cash.toFixed(2)}`,
    `Buying Power: $${account.buying_power.toFixed(2)}`,
    `Daily P&L: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)} (${dailyPnlPct.toFixed(2)}%)`,
    `Open Positions: ${positions.length}/${RISK_RULES.MAX_POSITIONS}`,
    `Unrealised P&L: ${totalUnrealised >= 0 ? '+' : ''}$${totalUnrealised.toFixed(2)}`,
  ].join(' | ');
}
