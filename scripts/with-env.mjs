#!/usr/bin/env node
// Runs a command with the variables of ./.env (if present) loaded, using Node's
// own parser (handles quotes and the JSON in INTEGRATION_CLIENTS). Variables
// already set in the environment win, so CI and systemd units are unaffected.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// ./.env is optional; an explicit PULSE_ENV_FILE must be readable, otherwise
// the service would start without its settings and fail far from the cause.
const explicit = process.env.PULSE_ENV_FILE;
const file = explicit ?? '.env';
if (explicit || existsSync(file)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`with-env: cannot read PULSE_ENV_FILE=${file} (${e.code ?? e.message}). Check that it exists and that this user may read it and its directory.`);
    process.exit(78); // EX_CONFIG
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
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
