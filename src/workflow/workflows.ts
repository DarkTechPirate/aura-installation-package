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
        intent:   'market_scan',
        parallel: true,
        steps: [
          {
            toolName: 'forex_scan',
            args: {
              instruments: ['XAU_USD', 'EUR_USD', 'GBP_USD', 'USD_JPY', 'GBP_JPY', 'XAG_USD'],
              granularity: 'D',
            },
          },
          { toolName: 'forex_account',   args: {} },
          { toolName: 'forex_positions', args: {} },
        ],
        llmInstruction:
          'Based on the scan results and current account state, give a concise market overview ' +
          'and up to 3 trade ideas ranked by conviction. Be direct and specific — name the instrument, ' +
          'direction, and key reason. Flag any correlation risk with open positions.',
      };

    case 'account_review':
      return {
        intent:   'account_review',
        parallel: true,
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
        intent:   'pre_trade_check',
        parallel: false,
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
        intent:   'quick_quote',
        parallel: false,
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
        intent:   'close_trade',
        parallel: false,
        steps: [
          { id: 'positions', toolName: 'forex_positions', args: {} },
          {
            id:       'close',
            toolName: 'forex_close',
            // Closes the first open trade. LLM narrates what was closed.
            args: { trade_id: '$positions.trades[0].id' },
          },
        ],
        llmInstruction:
          'Confirm the trade has been closed. State the instrument, units, and realised P&L if available. ' +
          'If the close failed (error in result), explain what went wrong and what to try instead.',
      };

    case 'cancel_order':
      return {
        intent:   'cancel_order',
        parallel: false,
        steps: [
          { id: 'orders', toolName: 'forex_orders', args: {} },
          {
            id:       'cancel',
            toolName: 'forex_cancel',
            // Cancels the first pending order. LLM confirms or escalates if multiple.
            args: { order_id: '$orders.orders[0].id' },
          },
        ],
        llmInstruction:
          'Confirm the order has been cancelled, naming the instrument and price. ' +
          'If multiple orders exist in the data, mention them and ask which to cancel next. ' +
          'If the cancel failed, explain why.',
      };

    case 'update_sltp': {
      return {
        intent:   'update_sltp',
        parallel: false,
        steps: [
          { id: 'positions', toolName: 'forex_positions', args: {} },
          // LLM will receive full positions data and the user's original message.
          // It will narrate the current SL/TP and suggest or confirm updates.
          // Actual forex_update_sltp requires new values the user must specify,
          // so we stop after fetching positions and let the LLM ask for confirmation.
        ],
        llmInstruction:
          'Show the current open trades with their SL and TP levels. ' +
          'Ask the user which trade to update and what the new SL/TP values should be. ' +
          'Do not execute the update without explicit confirmation of the new values.',
      };
    }

    // ── General: parallel pre-fetch ──────────────────────────────────────────

    case 'daily_brief':
      return {
        intent:   'daily_brief',
        parallel: true,
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
        intent:   'github_review',
        parallel: true,
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
        intent:   'web_research',
        parallel: false,
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
