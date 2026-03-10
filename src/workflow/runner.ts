/**
 * Workflow runner — executes steps defined in WorkflowDef, assembles results
 * into a context string for a single LLM call.
 */

import type { SkillContext } from '../skills/types.js';
import type { ToolCall } from '../llm/types.js';
import type { WorkflowDef } from './workflows.js';
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
  const results: StepResult[] = [];
  for (const step of def.steps) {
    try {
      const result = await execute(makeCall(step.toolName, step.args), ctx, sessionId);
      results.push({ toolName: step.toolName, result });
    } catch (err) {
      results.push({ toolName: step.toolName, error: err instanceof Error ? err.message : String(err) });
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

  const assembled = results.map(formatResult).join('\n\n');
  return assembled;
}
