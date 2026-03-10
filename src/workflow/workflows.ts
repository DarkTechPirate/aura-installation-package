/**
 * Workflow definitions for the hybrid orchestrator.
 * Each workflow maps an intent to a set of tool steps + an LLM instruction.
 *
 * Step chaining: sequential steps can reference prior step output via $ref.
 * e.g. args: { trade_id: '$positions.trades[0].id' }
 * The runner resolves $refs before calling each step. See runner.ts.
 */

import type { WorkflowMatch } from './intent.js';

export interface WorkflowStep {
  id?:      string;                    // optional — required if later steps $ref this step
  toolName: string;
  args:     Record<string, unknown>;   // values starting with '$' are resolved as $refs
}

export interface WorkflowDef {
  intent:         string;
  parallel:       boolean;   // true → Promise.allSettled; false → sequential + chaining
  steps:          WorkflowStep[];
  llmInstruction: string;    // appended after assembled data to guide the LLM reply
  /**
   * When false (default): orchestrator runs all steps, makes one-shot LLM call (no tools).
   * When true: orchestrator only pre-fetches data, injects it into context, then falls
   * into the normal LLM tool loop. Use for intents requiring LLM reasoning to select
   * the right record (e.g. close a specific trade by instrument name).
   */
  allowTools:     boolean;
}

/**
 * Resolves a detected intent to a concrete WorkflowDef with args filled in.
 * Returns null if essential args are missing — caller falls through to LLM loop.
 */
export function resolveWorkflow(match: WorkflowMatch): WorkflowDef | null {
  switch (match.intent) {

    // ── Forex: parallel pre-fetch ────────────────────────────────────────────

    case 'market_scan':
      return {
        intent:      'market_scan',
        parallel:    true,
        allowTools:  false,
        steps: [
          // Broad ranking — tells us which pairs have momentum right now
          {
            toolName: 'forex_scan',
            args: {
              instruments: ['XAU_USD', 'XAG_USD', 'EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY', 'AUD_USD', 'USD_CHF'],
              granularity: 'D',
            },
          },
          // Deep multi-timeframe analysis (D + H4 + H1 confluence) on the most traded pairs.
          // All run in parallel — no sequential dependency needed for market scan.
          { toolName: 'forex_analysis', args: { instrument: 'XAU_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'EUR_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'GBP_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'USD_JPY', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'XAG_USD', multi_tf: true } },
          // Positions for correlation check only — not the focus of this analysis
          { toolName: 'forex_positions', args: {} },
        ],
        llmInstruction:
          'You are writing a market briefing for an active trader. Rules:\n' +
          '- Focus ENTIRELY on the market data — technical setups, momentum, key price levels.\n' +
          '- Do NOT lead with or summarise open positions. Mention them only at the end as a one-line correlation note.\n' +
          '- For each of the top 2-3 setups: state instrument, direction, the specific technical reason ' +
          '(RSI level, EMA cross, Bollinger squeeze, S/R level — use actual values from the data), ' +
          'and concrete entry/SL/TP levels using the ATR data provided.\n' +
          '- Rank by conviction. If a pair has conflicting signals across timeframes, say so and rank it lower.\n' +
          '- No emojis. No section headers. Concise structured prose. Max 300 words.',
      };

    case 'account_review':
      return {
        intent:      'account_review',
        parallel:    true,
        allowTools:  false,
        steps: [
          { toolName: 'forex_account',   args: {} },
          { toolName: 'forex_positions', args: {} },
          { toolName: 'forex_orders',    args: {} },
        ],
        llmInstruction:
          'Summarise the account health, open P&L, risk exposure, and any pending orders. ' +
          'Flag anything that needs attention — trades near SL, large drawdown, or high margin usage.',
      };

    // ── Forex: single-step ───────────────────────────────────────────────────

    case 'pre_trade_check': {
      if (!match.instrument || !match.side) return null;
      return {
        intent:      'pre_trade_check',
        parallel:    false,
        allowTools:  false,
        steps: [
          {
            toolName: 'forex_pre_trade',
            args: { instrument: match.instrument, side: match.side },
          },
        ],
        llmInstruction:
          'Give a clear go / no-go trade recommendation with key reasons. ' +
          'If proceed is true, state the suggested entry, SL, TP, and R:R ratio. ' +
          'If proceed is false, explain exactly why and suggest what to wait for.',
      };
    }

    case 'quick_quote': {
      if (!match.instrument) return null;
      return {
        intent:      'quick_quote',
        parallel:    false,
        allowTools:  false,
        steps: [
          {
            toolName: 'forex_quote',
            args: { instrument: match.instrument },
          },
        ],
        llmInstruction:
          'Present the current price cleanly — bid, ask, spread. ' +
          'Add one-liner context if the spread or price level is notable.',
      };
    }

    // ── Forex: chained sequential ────────────────────────────────────────────

    case 'close_trade':
      return {
        intent:      'close_trade',
        parallel:    false,
        allowTools:  true,   // LLM picks the right trade_id from positions and calls forex_close
        steps: [
          { id: 'positions', toolName: 'forex_positions', args: {} },
        ],
        llmInstruction:
          'The user wants to close a trade. Using the positions data above, identify the correct trade ' +
          'by instrument name, then call forex_close with that trade_id. ' +
          'If multiple trades match or the instrument is ambiguous, ask the user to confirm which one.',
      };

    case 'cancel_order':
      return {
        intent:      'cancel_order',
        parallel:    false,
        allowTools:  true,   // LLM picks the right order_id and calls forex_cancel
        steps: [
          { id: 'orders', toolName: 'forex_orders', args: {} },
        ],
        llmInstruction:
          'The user wants to cancel an order. Using the orders data above, identify the correct order ' +
          'by instrument name or price, then call forex_cancel with that order_id. ' +
          'If multiple orders exist and the intent is ambiguous, list them and ask which to cancel.',
      };

    case 'update_sltp': {
      return {
        intent:      'update_sltp',
        parallel:    false,
        allowTools:  true,   // LLM reads positions, asks for values if missing, then calls forex_update_sltp
        steps: [
          { id: 'positions', toolName: 'forex_positions', args: {} },
        ],
        llmInstruction:
          'The user wants to update SL/TP on a trade. Using the positions data above, identify the correct ' +
          'trade. If the user has specified new SL/TP values, call forex_update_sltp immediately. ' +
          'If values are missing, show current SL/TP and ask for the new ones before acting.',
      };
    }

    // ── General: parallel pre-fetch ──────────────────────────────────────────

    case 'daily_brief':
      return {
        intent:      'daily_brief',
        parallel:    true,
        allowTools:  false,
        steps: [
          { toolName: 'calendar_list_events', args: { days_ahead: 1 } },
          { toolName: 'list_reminders',       args: {} },
          { toolName: 'forex_account',        args: {} },
        ],
        llmInstruction:
          'Give a crisp morning brief covering: (1) today\'s calendar events, (2) any pending reminders, ' +
          '(3) account snapshot. Keep it punchy — bullet points, no fluff. Flag anything urgent.',
      };

    case 'github_review':
      return {
        intent:      'github_review',
        parallel:    true,
        allowTools:  false,
        steps: [
          { toolName: 'list_prs',    args: { state: 'open' } },
          { toolName: 'list_issues', args: { state: 'open' } },
        ],
        llmInstruction:
          'Summarise open PRs and issues. Flag anything that needs action — review requested, ' +
          'CI failing, or stale. Keep it brief and actionable.',
      };

    // ── General: chained sequential ──────────────────────────────────────────

    case 'web_research': {
      const query = match.query || '';
      if (!query) return null;
      return {
        intent:      'web_research',
        parallel:    false,
        allowTools:  false,
        steps: [
          {
            id:       'search',
            toolName: 'search',
            args: { query },
          },
          {
            id:       'browse',
            toolName: 'browse_url',
            // Follow the top search result for deeper content
            args: { url: '$search.results[0].url' },
          },
        ],
        llmInstruction:
          'Synthesise the search results and page content into a clear, factual answer. ' +
          'Cite the source URL. If the page content was unhelpful, rely on the search snippets.',
      };
    }

    default:
      return null;
  }
}
