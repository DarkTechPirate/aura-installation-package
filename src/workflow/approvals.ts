/**
 * Pending approval store for workflows that require human confirmation
 * before executing a destructive or irreversible action.
 *
 * Lobster-inspired improvements over the original:
 *   resumeToken  — each approval gets a unique short token.
 *                  Non-confirm/cancel messages no longer silently consume it.
 *   Session index — look up token by session_id without exposing it to the user.
 *
 * Flow:
 *   1. Orchestrator detects intent with requiresApproval=true
 *   2. Pre-fetch steps run (e.g. forex_positions)
 *   3. LLM generates a preview message ("About to close XAU_USD trade…")
 *   4. Preview + "Reply confirm to proceed" is sent to user
 *   5. PendingApproval (with token) is stored
 *   6. Next user message is checked — only confirm/cancel are handled.
 *      Any other message falls through to normal processing WITHOUT consuming
 *      the pending approval (unlike before).
 *   7. On confirm: LLM loop runs with pre-fetched data injected.
 */

import crypto from 'crypto';
import type { WorkflowDef } from './workflows.js';
import type { LLMMessage } from '../llm/types.js';

export interface PendingApproval {
  token:             string;         // unique short token per approval
  sessionId:         string;
  workflowDef:       WorkflowDef;
  assembled:         string;         // pre-fetched data from workflow steps
  originalText:      string;         // user's original message
  augmentedMessages: LLMMessage[];
  expiresAt:         number;         // epoch ms — approvals expire after 5 minutes
}

// ── Stores ────────────────────────────────────────────────────────────────────
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// token → approval
const byToken = new Map<string, PendingApproval>();
// sessionId → token (for lookup without exposing token)
const bySession = new Map<string, string>();

const CONFIRM_RE = /^\s*(yes|confirm|proceed|go|ok|okay|y|do it|execute|approve|sure)\s*[.!]?\s*$/i;
const CANCEL_RE  = /^\s*(no|cancel|abort|stop|nope|n|skip|forget it|nevermind|never mind)\s*[.!]?\s*$/i;

function generateToken(): string {
  return crypto.randomBytes(3).toString('hex'); // e.g. 'a3f7c1'
}

/** Store a pending approval for a session. Overwrites any existing one. */
export function storePendingApproval(sessionId: string, approval: Omit<PendingApproval, 'token' | 'sessionId'>): PendingApproval {
  // Clean up any existing approval for this session
  const oldToken = bySession.get(sessionId);
  if (oldToken) byToken.delete(oldToken);

  const token = generateToken();
  const entry: PendingApproval = { ...approval, token, sessionId };
  byToken.set(token, entry);
  bySession.set(sessionId, token);
  return entry;
}

/** Returns true if the text is a clear confirmation. */
export function isConfirmation(text: string): boolean {
  return CONFIRM_RE.test(text.trim());
}

/** Returns true if the text is a clear cancellation. */
export function isCancellation(text: string): boolean {
  return CANCEL_RE.test(text.trim());
}

/**
 * Retrieve and remove a pending approval by session.
 * Returns null if expired or not found.
 */
export function consumePendingApproval(sessionId: string): PendingApproval | null {
  const token = bySession.get(sessionId);
  if (!token) return null;
  const entry = byToken.get(token);
  byToken.delete(token);
  bySession.delete(sessionId);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry;
}

/**
 * Peek at a pending approval without consuming it.
 * Used when a non-confirm/cancel message arrives — we keep the approval alive.
 */
export function peekPendingApproval(sessionId: string): PendingApproval | null {
  const token = bySession.get(sessionId);
  if (!token) return null;
  const entry = byToken.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    byToken.delete(token ?? '');
    bySession.delete(sessionId);
    return null;
  }
  return entry;
}

/** Check whether a session has a pending approval. */
export function hasPendingApproval(sessionId: string): boolean {
  return peekPendingApproval(sessionId) !== null;
}

/** Prune expired entries. Call periodically. */
export function pruneExpiredApprovals(): void {
  const now = Date.now();
  for (const [token, entry] of byToken) {
    if (now > entry.expiresAt) {
      byToken.delete(token);
      bySession.delete(entry.sessionId);
    }
  }
}

/** Build a fresh PendingApproval entry with a 5-minute TTL. */
export function buildPendingApproval(params: {
  workflowDef:       WorkflowDef;
  assembled:         string;
  originalText:      string;
  augmentedMessages: LLMMessage[];
}): Omit<PendingApproval, 'token' | 'sessionId'> {
  return { ...params, expiresAt: Date.now() + TTL_MS };
}
