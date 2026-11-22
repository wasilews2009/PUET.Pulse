#!/usr/bin/env node
// Runs a command with the variables of ./.env (if present) loaded, using Node's
// own parser (handles quotes and the JSON in INTEGRATION_CLIENTS). Variables
// already set in the environment win, so CI and systemd units are unaffected.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const file = process.env.PULSE_ENV_FILE ?? '.env';
if (existsSync(file)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
