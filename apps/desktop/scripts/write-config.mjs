// Bakes the server address into the installer: writes dist/pulse.json from
// PULSE_URL and PULSE_SSO_HOSTS, validated by the same rules the app applies
// at start (dist/policy.js, built by `pnpm build`). Run before electron-builder.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const require = createRequire(import.meta.url);
const { BUNDLED_CONFIG_FILE, loadConfig } = require(path.join(dist, 'policy.js'));

if (!process.env.PULSE_URL) {
  console.error('Set PULSE_URL (e.g. https://pulse.puet.edu.ua) and optionally PULSE_SSO_HOSTS (e.g. sso.puet.edu.ua).');
  process.exit(1);
}
const ssoHosts = (process.env.PULSE_SSO_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const text = JSON.stringify({ url: process.env.PULSE_URL, ssoHosts }, null, 2) + '\n';
const cfg = loadConfig({ packaged: true, bundled: text, env: {} }); // throws on http, credentials, bad URL
writeFileSync(path.join(dist, BUNDLED_CONFIG_FILE), JSON.stringify({ url: cfg.origin, ssoHosts: cfg.ssoHosts }, null, 2) + '\n');
console.log(`Installer will open ${cfg.origin} (sign-in hosts: ${cfg.ssoHosts.join(', ') || 'none'})`);
