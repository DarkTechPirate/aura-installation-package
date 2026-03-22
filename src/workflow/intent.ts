/**
 * Intent detection for the hybrid workflow orchestrator.
 * Matches user messages to known structured workflows before the LLM loop runs.
 *
 * Priority order (forex):
 *   pre_trade_check → close_trade → cancel_order → update_sltp → market_scan → account_review
 * General:
 *   daily_brief → github_review → web_research
 */

export type IntentName =
  | 'market_scan'
  | 'account_review'
  | 'pre_trade_check'
  | 'instrument_analysis'
  | 'close_trade'
  | 'cancel_order'
  | 'update_sltp'
  | 'daily_brief'
  | 'github_review'
  | 'web_research';

export interface WorkflowMatch {
  intent:      IntentName;
  instrument?: string;       // normalised OANDA symbol e.g. 'XAU_USD'
  side?:       'buy' | 'sell';
  query?:      string;       // for web_research: the search query
}

// ── Instrument alias table ────────────────────────────────────────────────────
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

const ANALYSIS_RE = /\b(analys[ei]s?|analyse|analyze|deep.?dive|technical|chart|look at|review|check|signal|setup|what.?s happening|how.?is|hows)\b/i;

// ── Forex intent patterns ─────────────────────────────────────────────────────
const MARKET_SCAN_RE = /\b(scan|explore|market|what should i trade|best setup|opportunit|top picks?|watch.?list|what.?s hot|find.?trade|market overview|market check|market update|hows.?the|how.?is.?the|market condition|trade today|trading today|any setup|good trade)\b/i;
const ACCOUNT_RE     = /\b(my account|balance|portfolio|positions|how am i doing|p&?l|profit.?loss|drawdown|equity|account review|open trades?|account summary|my trades?|my profit|my loss|analys[ei]s? (the |my )?(trade|position|portfolio)|trade analysis|position analysis|analys[ei]s? trade|check (the |my )?(trade|position|portfolio|account))\b/i;
const CLOSE_TRADE_RE = /\b(close (my |the |a )?(trade|position|pos)|exit (trade|position|my trade)|close out)\b/i;
const CANCEL_ORDER_RE = /\b(cancel (my |the |an? )?(order|pending)|remove order|delete order|drop (the |my )?order)\b/i;
const UPDATE_SLTP_RE  = /\b(move (sl|tp|stop|take.?profit)|update (sl|tp|stop.?loss|take.?profit)|adjust (sl|tp|stop|take.?profit)|change (stop|sl|tp|take.?profit)|set (new )?(sl|tp|stop|take.?profit))\b/i;

// ── General intent patterns ───────────────────────────────────────────────────
const DAILY_BRIEF_RE  = /\b(good morning|morning brief|daily (brief|update|summary)|what.?s (on|happening) today|day ahead|start of day|today.?s overview)\b/i;
const GITHUB_RE       = /\b(github|pull request|open pr|pr status|check prs?|open issues?|ci (status|run)|repo status|my prs?)\b/i;
const WEB_RESEARCH_RE = /\b(search (for|the web for)?|look up|look it up|research|find out (about)?|google|what is|who is|what are|browse|web search)\b/i;

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

/** Extract the search query for web_research intent. Strips common trigger phrases. */
function extractQuery(text: string): string {
  return text
    .replace(/\b(search (for|the web for)?|look up|look it up|research|find out (about)?|google|browse|web search)\b/gi, '')
    .replace(/[?!]+$/, '')
    .trim();
}

/**
 * Detects a known workflow intent from the user message.
 * Returns null if no intent matches — falls through to the LLM loop.
 */
export function detectIntent(text: string): WorkflowMatch | null {
  const instrument = extractInstrument(text);
  const side       = extractSide(text);

  // ── Forex intents (highest priority) ────────────────────────────────────────

  // 1. pre_trade_check — instrument + side both present
  if (instrument && side) {
    return { intent: 'pre_trade_check', instrument, side };
  }

  // 1b. instrument_analysis — instrument present, no side, analysis-type message
  if (instrument && !side && ANALYSIS_RE.test(text)) {
    return { intent: 'instrument_analysis', instrument };
  }

  // 2. close_trade — must detect before quick_quote (instrument alone would match)
  if (CLOSE_TRADE_RE.test(text)) {
    return { intent: 'close_trade' };
  }

  // 3. cancel_order
  if (CANCEL_ORDER_RE.test(text)) {
    return { intent: 'cancel_order' };
  }

  // 4. update_sltp
  if (UPDATE_SLTP_RE.test(text)) {
    return { intent: 'update_sltp', instrument };
  }

  // 5. market_scan
  if (MARKET_SCAN_RE.test(text)) {
    return { intent: 'market_scan' };
  }

  // 7. account_review
  if (ACCOUNT_RE.test(text)) {
    return { intent: 'account_review' };
  }

  // ── General intents ──────────────────────────────────────────────────────────

  // 8. daily_brief
  if (DAILY_BRIEF_RE.test(text)) {
    return { intent: 'daily_brief' };
  }

  // 9. github_review
  if (GITHUB_RE.test(text)) {
    return { intent: 'github_review' };
  }

  // 10. web_research — low priority, only if clearly a search request
  if (WEB_RESEARCH_RE.test(text)) {
    return { intent: 'web_research', query: extractQuery(text) };
  }

  return null;
}
