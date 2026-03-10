/**
 * Workflow definitions for the hybrid orchestrator.
 * Each workflow maps an intent to a set of tool steps + an LLM instruction.
 */

import type { WorkflowMatch } from './intent.js';

export interface WorkflowStep {
  toolName: string;
  args:     Record<string, unknown>;
}

export interface WorkflowDef {
  intent:         string;
  parallel:       boolean;   // true → Promise.allSettled; false → sequential
  steps:          WorkflowStep[];
  llmInstruction: string;    // appended after assembled data to guide the LLM reply
}

/**
 * Resolves a detected intent to a concrete WorkflowDef with args filled in.
 * Returns null if essential args are missing — caller falls through to LLM loop.
 */
export function resolveWorkflow(match: WorkflowMatch): WorkflowDef | null {
  switch (match.intent) {

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

    default:
      return null;
  }
}
