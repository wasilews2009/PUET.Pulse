/**
 * Prints a new VAPID key pair for Web Push as .env lines. Run once per server
 * and append the output to the env file; changing the keys later makes every
 * phone subscribe again on its next start.
 *
 *   pnpm --silent --filter @puet/api push:keys | sudo tee -a /etc/puet/pulse.env
 */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
