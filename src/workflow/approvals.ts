/**
 * Pending approval store for workflows that require human confirmation
 * before executing a destructive or irreversible action.
 *
 * Flow (mirrors Lobster's approval: required):
 *   1. Orchestrator detects intent with requiresApproval=true
 *   2. Pre-fetch steps run (e.g. forex_positions)
 *   3. LLM generates a preview message ("About to close XAU_USD trade…")
 *   4. Preview + "Reply confirm to proceed" is sent to user
 *   5. PendingApproval is stored keyed by session_id
 *   6. Next user message is checked — if it matches CONFIRM_RE, resume is triggered
 *   7. LLM loop runs with pre-fetched data + user confirmation injected
 */

import type { WorkflowDef } from './workflows.js';
import type { LLMMessage } from '../llm/types.js';

export interface PendingApproval {
  workflowDef:       WorkflowDef;
  assembled:         string;         // pre-fetched data from workflow steps
  originalText:      string;         // user's original message
  augmentedMessages: LLMMessage[];   // params.messages with pre-fetch injected
  expiresAt:         number;         // epoch ms — approvals expire after 5 minutes
}

// ── In-memory store ───────────────────────────────────────────────────────────
const TTL_MS  = 5 * 60 * 1000; // 5 minutes
const store   = new Map<string, PendingApproval>();

const CONFIRM_RE = /^\s*(yes|confirm|proceed|go|ok|okay|y|do it|execute|approve|sure)\s*[.!]?\s*$/i;
const CANCEL_RE  = /^\s*(no|cancel|abort|stop|nope|n|skip|forget it|nevermind|never mind)\s*[.!]?\s*$/i;

/** Store a pending approval for a session. Overwrites any existing one. */
export function storePendingApproval(sessionId: string, approval: PendingApproval): void {
  store.set(sessionId, approval);
}

/** Returns true if the text is a clear confirmation. */
export function isConfirmation(text: string): boolean {
  return CONFIRM_RE.test(text.trim());
}

/** Returns true if the text is a clear cancellation. */
export function isCancellation(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

/** Retrieve and remove a pending approval. Returns null if expired or not found. */
export function consumePendingApproval(sessionId: string): PendingApproval | null {
  const entry = store.get(sessionId);
  if (!entry) return null;
  store.delete(sessionId);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

/** Check whether a session has a pending approval without consuming it. */
export function hasPendingApproval(sessionId: string): boolean {
  const entry = store.get(sessionId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { store.delete(sessionId); return false; }
  return true;
}

/** Prune expired entries. Call periodically (e.g. on the 10-minute cleanup timer). */
export function pruneExpiredApprovals(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}

/** Build a fresh PendingApproval entry with a 5-minute TTL. */
export function buildPendingApproval(params: {
  workflowDef:       WorkflowDef;
  assembled:         string;
  originalText:      string;
  augmentedMessages: LLMMessage[];
}): PendingApproval {
  return { ...params, expiresAt: Date.now() + TTL_MS };
}
