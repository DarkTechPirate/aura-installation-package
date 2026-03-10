/**
 * Workflow runner — executes steps defined in WorkflowDef, assembles results
 * into a context string for a single LLM call.
 *
 * Features (inspired by OpenClaw's Lobster engine):
 *   $ref chaining  — step args resolved from prior step results at runtime
 *   condition      — skip steps whose condition evaluates false
 *   loop           — repeat a step up to N times until a condition is met
 *   sub-workflow   — a step can inline another WorkflowDef recursively
 */

import type { SkillContext } from '../skills/types.js';
import type { ToolCall }     from '../llm/types.js';
import type { WorkflowDef, WorkflowStep } from './workflows.js';
import { resolveWorkflow } from './workflows.js';
import { createLogger }    from '../logger.js';

const logger = createLogger('Workflow');

const MAX_RESULT_CHARS = 5000; // per tool — multi-TF analysis needs headroom

export interface StepResult {
  toolName:  string;
  result?:   unknown;
  error?:    string;
  skipped?:  boolean;
}

type ExecuteFn = (call: ToolCall, ctx: SkillContext, sessionId: string) => Promise<unknown>;

// Monotonic counter — guarantees unique IDs even when multiple steps with the
// same toolName are started in the same millisecond (e.g. parallel forex_analysis).
let _callSeq = 0;
function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `wf-${toolName}-${++_callSeq}`, name: toolName, args };
}

function formatResult(stepResult: StepResult): string {
  if (stepResult.skipped) {
    return `[Tool: ${stepResult.toolName}]\nSkipped (condition not met)`;
  }
  if (stepResult.error) {
    return `[Tool: ${stepResult.toolName}]\nError: ${stepResult.error}`;
  }
  const raw    = JSON.stringify(stepResult.result, null, 2);
  const capped = raw.length > MAX_RESULT_CHARS
    ? raw.slice(0, MAX_RESULT_CHARS) + `\n...[truncated — ${raw.length} total chars]`
    : raw;
  return `[Tool: ${stepResult.toolName}]\n${capped}`;
}

// ── $ref resolution ──────────────────────────────────────────────────────────
// Walks a dot-path with optional array index: '$stepId.trades[0].id'

function walkPath(val: unknown, pathParts: string[]): unknown {
  for (const part of pathParts) {
    if (val == null) break;
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      val = (val as Record<string, unknown[]>)[arrMatch[1]!]?.[Number(arrMatch[2])];
    } else if (part === 'length' && Array.isArray(val)) {
      val = (val as unknown[]).length;
    } else {
      val = (val as Record<string, unknown>)[part];
    }
  }
  return val;
}

function resolveRef(ref: string, resultMap: Map<string, unknown>): unknown {
  const [stepId, ...pathParts] = ref.slice(1).split('.');
  const val = walkPath(resultMap.get(stepId!), pathParts);
  if (val == null) logger.warn(`$ref '${ref}' resolved to null/undefined`);
  return val;
}

export function resolveArgs(
  args:      Record<string, unknown>,
  resultMap: Map<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v !== 'string' || !v.startsWith('$')) return [k, v];
      return [k, resolveRef(v, resultMap)];
    })
  );
}

// ── Condition evaluator ──────────────────────────────────────────────────────
// Evaluates expressions like '$positions.trades.length > 0'
// Supports: ===, !==, >, <, >=, <=

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === 'null' || t === 'undefined') return null;
  if (t === 'true')  return true;
  if (t === 'false') return false;
  if (!isNaN(Number(t)) && t !== '') return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function evaluateCondition(expr: string, resultMap: Map<string, unknown>): boolean {
  // Resolve all $ref tokens in the expression
  const resolved = expr.replace(/\$\w+[\w.\[\]]*/g, (match) => {
    const val = resolveRef(match, resultMap);
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'string') return `"${val}"`;
    return String(val);
  });

  // Parse: left  op  right
  const m = resolved.match(/^(.+?)\s*(===|!==|>=|<=|>|<)\s*(.+)$/);
  if (!m) {
    logger.warn(`condition '${expr}' could not be parsed — skipping step`);
    return false;
  }
  const l = parseScalar(m[1]!);
  const r = parseScalar(m[3]!);
  switch (m[2]) {
    case '===': return l === r;
    case '!==': return l !== r;
    case '>':   return Number(l) > Number(r);
    case '<':   return Number(l) < Number(r);
    case '>=':  return Number(l) >= Number(r);
    case '<=':  return Number(l) <= Number(r);
    default:    return false;
  }
}

// ── Parallel execution ───────────────────────────────────────────────────────

async function runParallel(
  def:       WorkflowDef,
  ctx:       SkillContext,
  sessionId: string,
  execute:   ExecuteFn,
): Promise<StepResult[]> {
  const settled = await Promise.allSettled(
    def.steps.map(step =>
      execute(makeCall(step.toolName!, step.args), ctx, sessionId)
        .then(result => ({ toolName: step.toolName!, result } satisfies StepResult))
        .catch(err   => ({ toolName: step.toolName!, error: err instanceof Error ? err.message : String(err) } satisfies StepResult))
    )
  );
  return settled.map(s => s.status === 'fulfilled' ? s.value : { toolName: 'unknown', error: 'rejected' });
}

// ── Sequential execution (with $ref, condition, loop, sub-workflow) ──────────

async function runStep(
  step:      WorkflowStep,
  resultMap: Map<string, unknown>,
  ctx:       SkillContext,
  sessionId: string,
  execute:   ExecuteFn,
): Promise<StepResult> {
  const label = step.toolName ?? `workflow:${step.subWorkflow}`;

  // ── Condition gate ──────────────────────────────────────────────────────
  if (step.condition !== undefined) {
    const pass = evaluateCondition(step.condition, resultMap);
    if (!pass) {
      logger.info(`Step '${label}' skipped — condition false: ${step.condition}`);
      if (step.id) resultMap.set(step.id, null);
      return { toolName: label, skipped: true };
    }
  }

  // ── Sub-workflow ────────────────────────────────────────────────────────
  if (step.subWorkflow) {
    const subDef = resolveWorkflow({ intent: step.subWorkflow });
    if (!subDef) {
      const err = `Sub-workflow '${step.subWorkflow}' could not be resolved`;
      if (step.id) resultMap.set(step.id, null);
      return { toolName: label, error: err };
    }
    const subAssembled = await runWorkflow(subDef, ctx, execute, sessionId);
    if (step.id) resultMap.set(step.id, subAssembled);
    return { toolName: label, result: subAssembled };
  }

  // ── Loop support ────────────────────────────────────────────────────────
  if (step.loop) {
    const { maxIterations, condition } = step.loop;
    let lastResult: unknown = null;
    for (let i = 0; i < maxIterations; i++) {
      const resolvedArgs = resolveArgs(step.args, resultMap);
      try {
        lastResult = await execute(makeCall(step.toolName!, resolvedArgs), ctx, sessionId);
        if (step.id) resultMap.set(step.id, lastResult);
        if (evaluateCondition(condition, resultMap)) {
          logger.info(`Loop step '${label}' completed after ${i + 1} iteration(s)`);
          break;
        }
        logger.info(`Loop step '${label}' iteration ${i + 1}/${maxIterations} — condition not yet met`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (step.id) resultMap.set(step.id, null);
        return { toolName: step.toolName!, error: msg };
      }
    }
    return { toolName: step.toolName!, result: lastResult };
  }

  // ── Normal step (with $ref resolution) ─────────────────────────────────
  const resolvedArgs = resolveArgs(step.args, resultMap);
  try {
    const result = await execute(makeCall(step.toolName!, resolvedArgs), ctx, sessionId);
    if (step.id) resultMap.set(step.id, result);
    return { toolName: step.toolName!, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (step.id) resultMap.set(step.id, null);
    return { toolName: step.toolName!, error: msg };
  }
}

async function runSequential(
  def:       WorkflowDef,
  ctx:       SkillContext,
  sessionId: string,
  execute:   ExecuteFn,
): Promise<StepResult[]> {
  const results:   StepResult[]         = [];
  const resultMap: Map<string, unknown> = new Map();

  for (const step of def.steps) {
    const stepResult = await runStep(step, resultMap, ctx, sessionId, execute);
    results.push(stepResult);
  }
  return results;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Executes all workflow steps and returns an assembled context string
 * ready to be injected into the LLM user message.
 */
export async function runWorkflow(
  def:       WorkflowDef,
  ctx:       SkillContext,
  execute:   ExecuteFn,
  sessionId: string,
): Promise<string> {
  const t0 = Date.now();

  const results = def.parallel
    ? await runParallel(def, ctx, sessionId, execute)
    : await runSequential(def, ctx, sessionId, execute);

  const successCount = results.filter(r => !r.error && !r.skipped).length;
  const skippedCount = results.filter(r => r.skipped).length;
  logger.info(`Workflow complete`, {
    intent:   def.intent,
    steps:    def.steps.length,
    success:  successCount,
    skipped:  skippedCount,
    ms:       Date.now() - t0,
  });

  return results.map(formatResult).join('\n\n');
}
