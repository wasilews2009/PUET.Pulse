/**
 * Sends one signed sync batch from a JSON file, exactly as the HR system,
 * ЄДЕБО or ERP would. Useful for a pilot before those systems are connected:
 *
 *   pnpm sync:send hr/staff staff.json
 *   pnpm sync:send edebo/students students.json
 *   pnpm sync:send teaching-load load.json
 *   pnpm sync:send offboarding leavers.json
 *
 * The client (default "pilot", or SYNC_CLIENT) must exist in INTEGRATION_CLIENTS
 * with the matching kind. The API validates the file with the same schemas as
 * the real webhooks (apps/api/src/integrations/schemas.ts) and reports errors
 * per record. SYNC_API_URL defaults to http://127.0.0.1:3000.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sign } from '../src/integrations/hmac';

const PATHS = ['hr/staff', 'edebo/students', 'teaching-load', 'offboarding'] as const;

async function main() {
  const [path, file] = process.argv.slice(2);
  if (!path || !file || !(PATHS as readonly string[]).includes(path)) {
    throw new Error(`Usage: sync:send <${PATHS.join(' | ')}> <file.json>`);
  }
  const clientId = process.env.SYNC_CLIENT ?? 'pilot';
  const clients = JSON.parse(process.env.INTEGRATION_CLIENTS ?? '{}') as Record<string, { secret?: string }>;
  const secret = clients[clientId]?.secret;
  if (!secret) throw new Error(`INTEGRATION_CLIENTS has no "${clientId}" client`);
  const body = JSON.stringify(JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')));
  const api = (process.env.SYNC_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const res = await fetch(`${api}/integrations/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-puet-client': clientId,
      'x-puet-signature': sign(secret, Math.floor(Date.now() / 1000), body),
      'idempotency-key': randomUUID(),
    },
    body,
  });
  const text = await res.text();
  console.log(`HTTP ${res.status} ${text}`);
  if (!res.ok) process.exit(1);
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
