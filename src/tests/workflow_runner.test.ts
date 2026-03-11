/**
 * Tests for workflow runner features:
 * - $ref chaining
 * - condition gates
 * - loops
 * - sub-workflows
 * - parallel execution
 * - dynamic scorer (evaluateCondition)
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveArgs, evaluateCondition } from '../workflow/runner.js';
import { runWorkflow } from '../workflow/runner.js';
import type { WorkflowDef } from '../workflow/workflows.js';
import type { SkillContext } from '../skills/types.js';

const mockCtx = {} as SkillContext;

// ── $ref resolution ───────────────────────────────────────────────────────────

describe('resolveArgs — $ref chaining', () => {
  it('resolves a simple $ref', () => {
    const resultMap = new Map([['search', { url: 'https://example.com' }]]);
    const args = resolveArgs({ url: '$search.url' }, resultMap);
    expect(args.url).toBe('https://example.com');
  });

  it('resolves array index $ref', () => {
    const resultMap = new Map([['search', { results: [{ url: 'https://first.com' }, { url: 'https://second.com' }] }]]);
    const args = resolveArgs({ url: '$search.results[0].url' }, resultMap);
    expect(args.url).toBe('https://first.com');
  });

  it('resolves .length on array', () => {
    const resultMap = new Map([['search', { results: ['a', 'b', 'c'] }]]);
    const args = resolveArgs({ count: '$search.results.length' }, resultMap);
    expect(args.count).toBe(3);
  });

  it('passes non-ref values through unchanged', () => {
    const resultMap = new Map();
    const args = resolveArgs({ instrument: 'XAU_USD', multi_tf: true }, resultMap);
    expect(args.instrument).toBe('XAU_USD');
    expect(args.multi_tf).toBe(true);
  });

  it('returns undefined for missing $ref', () => {
    const resultMap = new Map();
    const args = resolveArgs({ url: '$search.url' }, resultMap);
    expect(args.url).toBeUndefined();
  });
});

// ── Condition evaluator ───────────────────────────────────────────────────────

describe('evaluateCondition', () => {
  it('evaluates > operator', () => {
    const resultMap = new Map([['search', { results: ['a', 'b'] }]]);
    expect(evaluateCondition('$search.results.length > 0', resultMap)).toBe(true);
    expect(evaluateCondition('$search.results.length > 5', resultMap)).toBe(false);
  });

  it('evaluates === operator', () => {
    const resultMap = new Map([['step1', { status: 'ok' }]]);
    expect(evaluateCondition('$step1.status === "ok"', resultMap)).toBe(true);
    expect(evaluateCondition('$step1.status === "fail"', resultMap)).toBe(false);
  });

  it('evaluates !== operator', () => {
    const resultMap = new Map([['step1', { status: 'ok' }]]);
    expect(evaluateCondition('$step1.status !== "fail"', resultMap)).toBe(true);
  });

  it('evaluates >= and <= operators', () => {
    const resultMap = new Map([['data', { count: 3 }]]);
    expect(evaluateCondition('$data.count >= 3', resultMap)).toBe(true);
    expect(evaluateCondition('$data.count <= 3', resultMap)).toBe(true);
    expect(evaluateCondition('$data.count >= 4', resultMap)).toBe(false);
  });

  it('returns false for null $ref', () => {
    const resultMap = new Map();
    expect(evaluateCondition('$missing.value > 0', resultMap)).toBe(false);
  });

  it('returns false for unparseable expression', () => {
    const resultMap = new Map();
    expect(evaluateCondition('not a valid expression', resultMap)).toBe(false);
  });
});

// ── runWorkflow — condition gate ──────────────────────────────────────────────

describe('runWorkflow — condition gate', () => {
  it('skips a step when condition is false', async () => {
    const execute = vi.fn().mockResolvedValue({ results: [] });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: false,
      allowTools: false,
      steps: [
        { id: 'search', toolName: 'search', args: { query: 'test' } },
        {
          id: 'browse',
          toolName: 'browse_url',
          args: { url: '$search.results[0].url' },
          condition: '$search.results.length > 0',
        },
      ],
      llmInstruction: '',
    };

    const { assembled: result } = await runWorkflow(def, mockCtx, execute, 'sess1');
    // browse_url should never be called — condition false (empty results)
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'search' }), mockCtx, 'sess1');
    expect(result).toContain('Skipped');
  });

  it('runs a step when condition is true', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ results: [{ url: 'https://example.com' }] })
      .mockResolvedValueOnce({ content: 'page content' });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: false,
      allowTools: false,
      steps: [
        { id: 'search', toolName: 'search', args: { query: 'test' } },
        {
          id: 'browse',
          toolName: 'browse_url',
          args: { url: '$search.results[0].url' },
          condition: '$search.results.length > 0',
        },
      ],
      llmInstruction: '',
    };

    await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'browse_url', args: { url: 'https://example.com' } }),
      mockCtx, 'sess1',
    );
  });
});

// ── runWorkflow — loop ────────────────────────────────────────────────────────

describe('runWorkflow — loop', () => {
  it('stops loop when condition is met', async () => {
    let callCount = 0;
    const execute = vi.fn().mockImplementation(async () => {
      callCount++;
      return { done: callCount >= 2 };
    });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: false,
      allowTools: false,
      steps: [
        {
          id: 'poll',
          toolName: 'poll_tool',
          args: {},
          loop: { maxIterations: 5, condition: '$poll.done === true' },
        },
      ],
      llmInstruction: '',
    };

    await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('stops at maxIterations if condition never met', async () => {
    const execute = vi.fn().mockResolvedValue({ done: false });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: false,
      allowTools: false,
      steps: [
        {
          id: 'poll',
          toolName: 'poll_tool',
          args: {},
          loop: { maxIterations: 3, condition: '$poll.done === true' },
        },
      ],
      llmInstruction: '',
    };

    await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

// ── runWorkflow — parallel ────────────────────────────────────────────────────

describe('runWorkflow — parallel', () => {
  it('runs all steps in parallel and returns all results', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: true,
      allowTools: false,
      steps: [
        { toolName: 'tool_a', args: {} },
        { toolName: 'tool_b', args: {} },
        { toolName: 'tool_c', args: {} },
      ],
      llmInstruction: '',
    };

    const { assembled: result } = await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result).toContain('tool_a');
    expect(result).toContain('tool_b');
    expect(result).toContain('tool_c');
  });

  it('continues even if one parallel step fails', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('tool_b failed'))
      .mockResolvedValueOnce({ ok: true });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: true,
      allowTools: false,
      steps: [
        { toolName: 'tool_a', args: {} },
        { toolName: 'tool_b', args: {} },
        { toolName: 'tool_c', args: {} },
      ],
      llmInstruction: '',
    };

    const { assembled: result } = await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(result).toContain('tool_b');
    expect(result).toContain('Error: tool_b failed');
    expect(result).toContain('tool_c');
  });
});

// ── runWorkflow — $ref chaining across steps ──────────────────────────────────

describe('runWorkflow — $ref chaining', () => {
  it('passes result of step 1 as arg to step 2', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ trade_id: 'T-42' })
      .mockResolvedValueOnce({ closed: true });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: false,
      allowTools: false,
      steps: [
        { id: 'positions', toolName: 'forex_positions', args: {} },
        { id: 'close',     toolName: 'forex_close',     args: { trade_id: '$positions.trade_id' } },
      ],
      llmInstruction: '',
    };

    await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'forex_close', args: { trade_id: 'T-42' } }),
      mockCtx, 'sess1',
    );
  });
});

// ── runWorkflow — unique call IDs (no ID collision) ───────────────────────────

describe('runWorkflow — unique call IDs', () => {
  it('generates unique IDs for same tool called multiple times in parallel', async () => {
    const seenIds = new Set<string>();
    const execute = vi.fn().mockImplementation(async (call) => {
      seenIds.add(call.id);
      return { ok: true };
    });

    const def: WorkflowDef = {
      intent: 'test',
      parallel: true,
      allowTools: false,
      steps: [
        { toolName: 'forex_analysis', args: { instrument: 'XAU_USD' } },
        { toolName: 'forex_analysis', args: { instrument: 'EUR_USD' } },
        { toolName: 'forex_analysis', args: { instrument: 'GBP_USD' } },
        { toolName: 'forex_analysis', args: { instrument: 'USD_JPY' } },
        { toolName: 'forex_analysis', args: { instrument: 'XAG_USD' } },
      ],
      llmInstruction: '',
    };

    await runWorkflow(def, mockCtx, execute, 'sess1');
    expect(seenIds.size).toBe(5); // all IDs must be unique
  });
});
