/**
 * Workflow definitions for the hybrid orchestrator.
 * Each workflow maps an intent to a set of tool steps + an LLM instruction.
 *
 * Step features:
 *   $ref chaining  — args: { id: '$stepId.path[0].field' } resolved at runtime
 *   condition      — skip step if expression evaluates false
 *   loop           — repeat step up to N times until condition is met
 *   subWorkflow    — run a nested workflow as a step (instead of a tool call)
 *
 * Workflow features:
 *   allowTools     — false: one-shot LLM narrate; true: LLM loop with tools
 *   requiresApproval — pause after pre-fetch, ask user to confirm before acting
 */

import type { IntentName, WorkflowMatch } from './intent.js';

export interface WorkflowStep {
  id?:          string;                    // required if later steps $ref this one
  toolName?:    string;                    // undefined when subWorkflow is set
  subWorkflow?: IntentName;               // run a nested workflow inline as a step
  args:         Record<string, unknown>;   // values starting '$' are $ref resolved
  /**
   * JSONPath-style condition evaluated against the result map before this step runs.
   * Step is skipped (not an error) if the expression evaluates to false.
   * Supported operators: ===, !==, >, <, >=, <=
   * Example: '$positions.trades.length > 0'
   */
  condition?:   string;
  /**
   * Loop this step up to maxIterations times until `condition` evaluates true.
   * The step's result map entry is updated each iteration.
   * Useful for polling (waiting for order fill, retrying a flaky API call).
   */
  loop?: {
    maxIterations: number;
    condition:     string;   // stop when this evaluates true
  };
}

export interface WorkflowDef {
  intent:           string;
  parallel:         boolean;   // true → Promise.allSettled; false → sequential + $ref
  steps:            WorkflowStep[];
  llmInstruction:   string;
  /**
   * false (default): orchestrator runs all steps → one-shot LLM call (no tools).
   * true: orchestrator pre-fetches only → injects data → normal LLM tool loop.
   */
  allowTools:       boolean;
  /**
   * When true: after pre-fetch, LLM generates a preview message + "confirm to proceed".
   * The action only runs after the user confirms. Mirrors Lobster's `approval: required`.
   * Only meaningful when allowTools=true (destructive action workflows).
   */
  requiresApproval?: boolean;
}

/**
 * Resolves a detected intent to a concrete WorkflowDef.
 * Returns null if essential args are missing — falls through to LLM loop.
 */
export function resolveWorkflow(match: WorkflowMatch): WorkflowDef | null {
  switch (match.intent) {

    // ── Forex: parallel narrate ──────────────────────────────────────────────

    case 'market_scan':
      return {
        intent:     'market_scan',
        parallel:   true,
        allowTools: false,
        steps: [
          {
            toolName: 'forex_scan',
            args: {
              instruments: ['XAU_USD', 'XAG_USD', 'EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY', 'AUD_USD', 'USD_CHF'],
              granularity: 'D',
            },
          },
          { toolName: 'forex_analysis', args: { instrument: 'XAU_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'EUR_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'GBP_USD', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'USD_JPY', multi_tf: true } },
          { toolName: 'forex_analysis', args: { instrument: 'XAG_USD', multi_tf: true } },
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
        intent:     'account_review',
        parallel:   true,
        allowTools: false,
        steps: [
          { toolName: 'forex_account',   args: {} },
          { toolName: 'forex_positions', args: {} },
          { toolName: 'forex_orders',    args: {} },
        ],
        llmInstruction:
          'Summarise the account health, open P&L, risk exposure, and any pending orders. ' +
          'Flag anything that needs attention — trades near SL, large drawdown, or high margin usage.',
      };

    // ── Forex: single-step narrate ───────────────────────────────────────────

    case 'pre_trade_check': {
      if (!match.instrument || !match.side) return null;
      return {
        intent:     'pre_trade_check',
        parallel:   false,
        allowTools: false,
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
        intent:     'quick_quote',
        parallel:   false,
        allowTools: false,
        steps: [
          { toolName: 'forex_quote', args: { instrument: match.instrument } },
        ],
        llmInstruction:
          'Present the current price cleanly — bid, ask, spread. ' +
          'Add one-liner context if the spread or price level is notable.',
      };
    }

    // ── Forex: pre-fetch → LLM acts (with approval) ─────────────────────────

    case 'close_trade':
      return {
        intent:           'close_trade',
        parallel:         false,
        allowTools:       true,
        requiresApproval: true,
        steps: [
          {
            id:        'positions',
            toolName:  'forex_positions',
            args:      {},
            condition: undefined,     // always fetch — even if empty, LLM should report
          },
        ],
        llmInstruction:
          'The user wants to close a trade. Using the positions data, identify the correct trade ' +
          'by instrument name, then call forex_close with that trade_id. ' +
          'If multiple trades match or the instrument is ambiguous, ask which one.',
      };

    case 'cancel_order':
      return {
        intent:           'cancel_order',
        parallel:         false,
        allowTools:       true,
        requiresApproval: true,
        steps: [
          {
            id:       'orders',
            toolName: 'forex_orders',
            args:     {},
          },
        ],
        llmInstruction:
          'The user wants to cancel an order. Using the orders data, identify the correct order ' +
          'by instrument name or price, then call forex_cancel with that order_id. ' +
          'If multiple orders exist and the intent is ambiguous, list them and ask which to cancel.',
      };

    case 'update_sltp':
      return {
        intent:           'update_sltp',
        parallel:         false,
        allowTools:       true,
        requiresApproval: true,
        steps: [
          {
            id:       'positions',
            toolName: 'forex_positions',
            args:     {},
          },
        ],
        llmInstruction:
          'The user wants to update SL/TP on a trade. Identify the correct trade from the positions data. ' +
          'If the user specified new SL/TP values, call forex_update_sltp immediately. ' +
          'If values are missing, show current SL/TP and ask for the new ones before acting.',
      };

    // ── General: parallel narrate ────────────────────────────────────────────

    case 'daily_brief':
      return {
        intent:     'daily_brief',
        parallel:   true,
        allowTools: false,
        steps: [
          { toolName: 'calendar_list_events', args: { days_ahead: 1 } },
          { toolName: 'list_reminders',       args: {} },
          { toolName: 'forex_account',        args: {} },
        ],
        llmInstruction:
          'Give a crisp morning brief: (1) today\'s calendar events, (2) pending reminders, ' +
          '(3) account snapshot. Bullet points, no fluff. Flag anything urgent.',
      };

    case 'github_review':
      return {
        intent:     'github_review',
        parallel:   true,
        allowTools: false,
        steps: [
          { toolName: 'list_prs',    args: { state: 'open' } },
          { toolName: 'list_issues', args: { state: 'open' } },
        ],
        llmInstruction:
          'Summarise open PRs and issues. Flag anything that needs action — review requested, ' +
          'CI failing, or stale. Brief and actionable.',
      };

    // ── General: chained search → browse ─────────────────────────────────────

    case 'web_research': {
      const query = match.query || '';
      if (!query) return null;
      return {
        intent:     'web_research',
        parallel:   false,
        allowTools: false,
        steps: [
          {
            id:       'search',
            toolName: 'search',
            args:     { query },
          },
          {
            id:        'browse',
            toolName:  'browse_url',
            args:      { url: '$search.results[0].url' },
            condition: '$search.results.length > 0',   // skip browse if no results
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
