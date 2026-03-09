#!/usr/bin/env node
/**
 * AURA Gateway — version-checked entry point (CommonJS).
 * Works on any Node.js version and gives a clear error when Node < 20.
 *
 * Usage:  node agent.cjs onboard
 *         node agent.cjs --daemon
 *         node agent.cjs status
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// ── Node.js version gate ───────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);

if (major < 20) {
  console.error('');
  console.error('  ❌  Node.js 20 or higher is required.');
  console.error('  You are running: Node.js ' + process.version);
  console.error('');
  console.error('  Install Node.js 20 via NVM (recommended):');
  console.error('');
  console.error('    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash');
  console.error('    source ~/.bashrc');
  console.error('    nvm install 20');
  console.error('    nvm use 20');
  console.error('    nvm alias default 20');
  console.error('');
  console.error('  Then re-run:  node agent.cjs onboard');
  console.error('');
  process.exit(1);
}

// ── Forward to the ESM entry point ────────────────────────────────────────
const entry = path.join(__dirname, '_agent.js');
const args  = process.argv.slice(2);

const result = spawnSync(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  cwd:   __dirname,
  env:   process.env,
});

process.exit(result.status ?? 0);
