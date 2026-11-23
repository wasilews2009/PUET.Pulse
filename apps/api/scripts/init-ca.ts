/**
 * Creates the internal university CA (УЕП) once, offline:
 *
 *   pnpm --filter @puet/api pki:init-ca /secure/path/puet-ca
 *
 * Writes ca.crt.pem and ca.key.pem (PKCS#8, mode 0600) into the given directory,
 * which must be outside the repository. Point PKI_CA_CERT_FILE / PKI_CA_KEY_FILE
 * at them. Keep an offline backup of the key; consider an HSM for production.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRootCa } from '../src/pki/x509';

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: pki:init-ca <directory outside the repository>');
  const target = resolve(dir);
  const repo = resolve(__dirname, '../../..');
  if (!relative(repo, target).startsWith('..')) throw new Error('Refusing to write CA keys inside the repository');
  const cert = join(target, 'ca.crt.pem');
  const key = join(target, 'ca.key.pem');
  if (existsSync(cert) || existsSync(key)) throw new Error('A CA already exists in this directory; refusing to overwrite');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const ca = await createRootCa({ commonName: 'PUET Internal Signing CA', years: 10 });
  writeFileSync(cert, ca.certificatePem, { mode: 0o644 });
  writeFileSync(key, ca.privateKeyPem, { mode: 0o600 });
  console.log(`CA written to ${target}`);
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
