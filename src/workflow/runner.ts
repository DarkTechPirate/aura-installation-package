/**
 * Workflow runner — executes steps defined in WorkflowDef, assembles results
 * into a context string for a single LLM call.
 *
 * Chaining: sequential steps can reference prior step results via $ref notation.
 * e.g. args: { trade_id: '$positions.trades[0].id' }
 * The runner resolves these before calling execute on each step.
 */

import type { SkillContext } from '../skills/types.js';
import type { ToolCall } from '../llm/types.js';
import type { WorkflowDef, WorkflowStep } from './workflows.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Workflow');

const MAX_RESULT_CHARS = 3000; // cap per tool to avoid context blowup

export interface StepResult {
  toolName: string;
  result?:  unknown;
  error?:   string;
}

type ExecuteFn = (call: ToolCall, ctx: SkillContext, sessionId: string) => Promise<unknown>;

function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `wf-${toolName}-${Date.now()}`, name: toolName, args };
}

function formatResult(stepResult: StepResult): string {
  if (stepResult.error) {
    return `[Tool: ${stepResult.toolName}]\nError: ${stepResult.error}`;
  }
  const raw = JSON.stringify(stepResult.result, null, 2);
  const capped = raw.length > MAX_RESULT_CHARS
    ? raw.slice(0, MAX_RESULT_CHARS) + `\n...[truncated — ${raw.length} total chars]`
    : raw;
  return `[Tool: ${stepResult.toolName}]\n${capped}`;
}

/**
 * Resolves $ref placeholders in step args using results from prior steps.
 * Syntax: '$stepId.field.path[0].subfield'
 * Returns the arg value unchanged if it is not a $ref string.
 */
function resolveArgs(
  args:      Record<string, unknown>,
  resultMap: Map<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v !== 'string' || !v.startsWith('$')) return [k, v];

      // Parse '$stepId.path[0].field' → stepId + path segments
      const [stepId, ...pathParts] = v.slice(1).split('.');
      let val: unknown = resultMap.get(stepId!);

      for (const part of pathParts) {
        if (val == null) break;
        // Handle array indexing: 'trades[0]'
        const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
        if (arrMatch) {
          val = (val as Record<string, unknown[]>)[arrMatch[1]!]?.[Number(arrMatch[2])];
        } else {
          val = (val as Record<string, unknown>)[part];
        }
      }

      if (val == null) {
        logger.warn(`$ref '${v}' resolved to null/undefined — step may fail`);
      }
      return [k, val];
    })
  );
}

async function runParallel(
  def:       WorkflowDef,
  ctx:       SkillContext,
  sessionId: string,
  execute:   ExecuteFn,
): Promise<StepResult[]> {
  const settled = await Promise.allSettled(
    def.steps.map(step =>
      execute(makeCall(step.toolName, step.args), ctx, sessionId)
        .then(result => ({ toolName: step.toolName, result } satisfies StepResult))
        .catch(err  => ({ toolName: step.toolName, error: err instanceof Error ? err.message : String(err) } satisfies StepResult))
    )
  );
  return settled.map(s => s.status === 'fulfilled' ? s.value : { toolName: 'unknown', error: 'rejected' });
}

async function runSequential(
  def:       WorkflowDef,
  ctx:       SkillContext,
  sessionId: string,
  execute:   ExecuteFn,
): Promise<StepResult[]> {
  const results:   StepResult[]        = [];
  const resultMap: Map<string, unknown> = new Map();

  for (const step of def.steps) {
    const resolvedArgs = resolveArgs(step.args, resultMap);
    try {
      const result = await execute(makeCall(step.toolName, resolvedArgs), ctx, sessionId);
      if (step.id) resultMap.set(step.id, result);
      results.push({ toolName: step.toolName, result });
    } catch (err) {
      results.push({ toolName: step.toolName, error: err instanceof Error ? err.message : String(err) });
      // Non-fatal: log and continue — subsequent steps that $ref this will get null
      if (step.id) resultMap.set(step.id, null);
    }
  }
  return results;
}

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

  const successCount = results.filter(r => !r.error).length;
  logger.info(`Workflow complete`, {
    intent:  def.intent,
    steps:   def.steps.length,
    success: successCount,
    ms:      Date.now() - t0,
  });

  return results.map(formatResult).join('\n\n');
}
