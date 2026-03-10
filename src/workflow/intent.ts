/**
 * Intent detection for the hybrid workflow orchestrator.
 * Matches user messages to known structured workflows before the LLM loop runs.
 * Priority order: pre_trade_check → quick_quote → market_scan → account_review
 */

export type IntentName =
  | 'market_scan'
  | 'account_review'
  | 'pre_trade_check'
  | 'quick_quote';

export interface WorkflowMatch {
  intent:      IntentName;
  instrument?: string;       // normalised OANDA symbol e.g. 'XAU_USD'
  side?:       'buy' | 'sell';
}

// ── Instrument alias table ────────────────────────────────────────────────────
// Maps regex patterns → normalised OANDA instrument symbol
const INSTRUMENT_ALIASES: Array<[RegExp, string]> = [
  [/\b(xau[_/]?usd|gold|xauusd)\b/i,           'XAU_USD'],
  [/\b(xag[_/]?usd|silver|xagusd)\b/i,          'XAG_USD'],
  [/\b(eur[_/]?usd|eurusd|euro)\b/i,             'EUR_USD'],
  [/\b(gbp[_/]?usd|gbpusd|cable|pound)\b/i,      'GBP_USD'],
  [/\b(usd[_/]?jpy|usdjpy)\b/i,                  'USD_JPY'],
  [/\b(gbp[_/]?jpy|gbpjpy)\b/i,                  'GBP_JPY'],
  [/\b(aud[_/]?usd|audusd|aussie)\b/i,            'AUD_USD'],
  [/\b(nzd[_/]?usd|nzdusd|kiwi)\b/i,             'NZD_USD'],
  [/\b(usd[_/]?cad|usdcad|loonie)\b/i,           'USD_CAD'],
  [/\b(usd[_/]?chf|usdchf|swissy)\b/i,           'USD_CHF'],
  [/\b(eur[_/]?gbp|eurgbp)\b/i,                  'EUR_GBP'],
  [/\b(eur[_/]?jpy|eurjpy)\b/i,                  'EUR_JPY'],
];

const SIDE_BUY  = /\b(buy|long|bullish|go long|buying)\b/i;
const SIDE_SELL = /\b(sell|short|bearish|go short|selling)\b/i;

const MARKET_SCAN_RE = /\b(scan|explore.?market|what should i trade|best setup|opportunit|top picks?|watch.?list|what.?s hot|find.?trade|market overview)\b/i;
const ACCOUNT_RE     = /\b(my account|balance|portfolio|positions|how am i doing|p&?l|profit.?loss|drawdown|equity|account review|open trades?|account summary)\b/i;

function extractInstrument(text: string): string | undefined {
  for (const [re, symbol] of INSTRUMENT_ALIASES) {
    if (re.test(text)) return symbol;
  }
  return undefined;
}

function extractSide(text: string): 'buy' | 'sell' | undefined {
  if (SIDE_BUY.test(text))  return 'buy';
  if (SIDE_SELL.test(text)) return 'sell';
  return undefined;
}

/**
 * Detects a known workflow intent from the user message.
 * Returns null if no intent matches — falls through to the LLM loop.
 */
export function detectIntent(text: string): WorkflowMatch | null {
  const instrument = extractInstrument(text);
  const side       = extractSide(text);

  // 1. pre_trade_check — instrument + side both present
  if (instrument && side) {
    return { intent: 'pre_trade_check', instrument, side };
  }

  // 2. quick_quote — instrument present, no directional intent
  if (instrument && !side) {
    // Only trigger quote if the user is asking about price, not a general question
    const priceAsk = /\b(price|quote|rate|how much|worth|value|current|live|now|bid|ask)\b/i;
    if (priceAsk.test(text) || !MARKET_SCAN_RE.test(text)) {
      return { intent: 'quick_quote', instrument };
    }
  }

  // 3. market_scan
  if (MARKET_SCAN_RE.test(text)) {
    return { intent: 'market_scan' };
  }

  // 4. account_review
  if (ACCOUNT_RE.test(text)) {
    return { intent: 'account_review' };
  }

  return null;
}
