#!/usr/bin/env node
/**
 * Gary — AURA's workflow subprocess.
 *
 * Spawned by the gateway (server.ts) for each workflow execution.
 * Communicates via JSON lines over stdin/stdout.
 * Tool calls are proxied back to the parent gateway for execution.
 *
 * Usage (direct / testing):
 *   echo '{"type":"run","intent":"account_review","sessionId":"test"}' | tsx gary.ts
 */
import './src/gary/process.js';
