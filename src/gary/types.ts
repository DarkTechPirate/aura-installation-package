/**
 * Gary — AURA's workflow subprocess (inspired by OpenClaw's Lobster).
 *
 * JSON-line protocol over stdin/stdout:
 *   Parent → Gary stdin : GaryRunRequest  (one message to kick off)
 *   Gary  → Parent stdout: GaryToolCallMsg (one per tool invocation)
 *   Parent → Gary stdin : GaryToolResultMsg (parent executes, sends result back)
 *   Gary  → Parent stdout: GaryResultMsg   (final assembled output)
 */

export interface GaryRunRequest {
  type:       'run';
  intent:     string;
  instrument?: string;
  side?:       string;
  query?:      string;
  sessionId:   string;
}

export interface GaryToolCallMsg {
  type:     'tool_call';
  id:       string;
  toolName: string;
  args:     Record<string, unknown>;
}

export interface GaryToolResultMsg {
  type:    'tool_result';
  id:      string;
  result?: unknown;
  error?:  string;
}

export interface GaryResultMsg {
  type:    'result';
  ok:      boolean;
  status:  'ok' | 'needs_approval' | 'error';
  output:  string;
}

export type ParentToGary = GaryRunRequest | GaryToolResultMsg;
export type GaryToParent = GaryToolCallMsg | GaryResultMsg;
