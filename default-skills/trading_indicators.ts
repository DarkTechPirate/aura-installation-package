/** Pure technical indicator calculations — no side effects, no API calls. */

export interface Bar {
  t: string;   // timestamp ISO
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
}

export interface IndicatorResult {
  symbol:    string;
  price:     number;
  change1d:  number;  // % change today
  ema20:     number;
  ema50:     number;
  rsi14:     number;
  macd:      { line: number; signal: number; histogram: number };
  bb:        { upper: number; middle: number; lower: number; pct: number };
  avgVolume: number;
  volume:    number;
  volumeRatio: number;  // current vs avg
  trend:     'bullish' | 'bearish' | 'neutral';
  signal:    'buy' | 'sell' | 'hold';
  score:     number;  // 0–100 composite score
  reasons:   string[];
}

function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...new Array(period - 1).fill(NaN));
  result.push(prev);
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function sma(prices: number[], period: number): number {
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stddev(prices: number[], period: number): number {
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(prices: number[]): { line: number; signal: number; histogram: number } {
  const ema12 = ema(prices, 12);
  const ema26 = ema(prices, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i])) ? NaN : v - ema26[i]);
  const validMacd = macdLine.filter(v => !isNaN(v));
  if (validMacd.length < 9) return { line: 0, signal: 0, histogram: 0 };
  const signalLine = ema(validMacd, 9);
  const line   = validMacd[validMacd.length - 1];
  const signal = signalLine[signalLine.length - 1];
  return { line, signal, histogram: line - signal };
}

export function analyze(bars: Bar[], symbol: string): IndicatorResult {
  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const price   = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] ?? price;
  const change1d  = ((price - prevClose) / prevClose) * 100;

  const ema20arr = ema(closes, 20);
  const ema50arr = ema(closes, 50);
  const ema20Val = ema20arr[ema20arr.length - 1] ?? price;
  const ema50Val = ema50arr[ema50arr.length - 1] ?? price;

  const rsi14     = rsi(closes);
  const macdVal   = macd(closes);
  const bbMid     = sma(closes, 20);
  const bbStd     = stddev(closes, 20);
  const bbUpper   = bbMid + 2 * bbStd;
  const bbLower   = bbMid - 2 * bbStd;
  const bbPct     = bbStd > 0 ? (price - bbLower) / (bbUpper - bbLower) : 0.5;
  const avgVolume = sma(volumes, 20);
  const volume    = volumes[volumes.length - 1];
  const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;

  const reasons: string[] = [];
  let score = 50;

  // Trend
  const aboveEma20 = price > ema20Val;
  const aboveEma50 = price > ema50Val;
  const trend: 'bullish' | 'bearish' | 'neutral' =
    aboveEma20 && aboveEma50 ? 'bullish' :
    !aboveEma20 && !aboveEma50 ? 'bearish' : 'neutral';

  if (trend === 'bullish') { score += 15; reasons.push('Price above EMA20 and EMA50'); }
  if (trend === 'bearish') { score -= 15; reasons.push('Price below EMA20 and EMA50'); }

  // RSI
  if (rsi14 < 30) { score += 10; reasons.push(`RSI oversold (${rsi14.toFixed(1)})`); }
  else if (rsi14 > 70) { score -= 10; reasons.push(`RSI overbought (${rsi14.toFixed(1)})`); }
  else if (rsi14 >= 40 && rsi14 <= 60) { score += 5; reasons.push(`RSI neutral (${rsi14.toFixed(1)})`); }

  // MACD
  if (macdVal.histogram > 0 && macdVal.line > macdVal.signal) { score += 10; reasons.push('MACD bullish crossover'); }
  if (macdVal.histogram < 0 && macdVal.line < macdVal.signal) { score -= 10; reasons.push('MACD bearish crossover'); }

  // Bollinger
  if (bbPct < 0.2) { score += 8; reasons.push('Price near lower Bollinger Band'); }
  if (bbPct > 0.8) { score -= 8; reasons.push('Price near upper Bollinger Band'); }

  // Volume
  if (volumeRatio > 1.5) { score += 7; reasons.push(`High volume (${volumeRatio.toFixed(1)}x average)`); }

  score = Math.max(0, Math.min(100, score));
  const signal: 'buy' | 'sell' | 'hold' = score >= 65 ? 'buy' : score <= 35 ? 'sell' : 'hold';

  return {
    symbol, price, change1d, ema20: ema20Val, ema50: ema50Val,
    rsi14, macd: macdVal,
    bb: { upper: bbUpper, middle: bbMid, lower: bbLower, pct: bbPct },
    avgVolume, volume, volumeRatio,
    trend, signal, score, reasons,
  };
}
