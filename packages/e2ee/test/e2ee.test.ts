import { describe, expect, it } from 'vitest';
import { PulseCrypto, unwrapSecret, wrapSecret } from '../src';
import { FakeKeyServer } from './fake-server';

const SERVER = 'pulse.test';
const ALICE = '0b6c1f1e-1111-4111-8111-111111111111';
const BOB = '1c7d2a2f-2222-4222-8222-222222222222';
const EVE = '2d8e3b30-3333-4333-8333-333333333333';
const CHANNEL = '3e9f4c41-4444-4444-8444-444444444444';
const mx = (u: string) => `@${u}:${SERVER}`;
const dev = (n: number) => `9a1c1f1e-0000-4000-8000-00000000000${n}`;

async function client(server: FakeKeyServer, user: string, device: string) {
  return PulseCrypto.create({ userId: user, serverName: SERVER, deviceId: device, transport: server.transport(mx(user), device) });
}

describe('end-to-end encryption (vodozemac Olm / Megolm)', () => {
  it('Alice encrypts for Bob; Bob decrypts; the server only stores ciphertext', async () => {
    const server = new FakeKeyServer();
    const alice = await client(server, ALICE, dev(1));
    const bob = await client(server, BOB, dev(2));

    const sent = await alice.encrypt(CHANNEL, [ALICE, BOB], { msgtype: 'm.text', body: 'Пара перенесена в ауд. 214' });
    const wire = Buffer.from(sent.ciphertext, 'base64').toString('utf8');
    expect(wire).not.toContain('214');
    expect(JSON.parse(wire).algorithm).toBe('m.megolm.v1.aes-sha2');

    await bob.sync(); // receives the Megolm session over Olm
    const got = await bob.decrypt({ id: 'm1', channelId: CHANNEL, senderId: ALICE, createdAt: new Date().toISOString(), ciphertext: sent.ciphertext });
    expect(got.content.body).toBe('Пара перенесена в ауд. 214');
    expect(got.senderDeviceId).toBe(dev(1));
  });

  it('confidentiality: a user who was not a member cannot decrypt', async () => {
    const server = new FakeKeyServer();
    const alice = await client(server, ALICE, dev(1));
    await client(server, BOB, dev(2));
    const eve = await client(server, EVE, dev(3));

    const sent = await alice.encrypt(CHANNEL, [ALICE, BOB], { msgtype: 'm.text', body: 'secret' });
    await eve.sync();
    await expect(
      eve.decrypt({ id: 'm1', channelId: CHANNEL, senderId: ALICE, createdAt: new Date().toISOString(), ciphertext: sent.ciphertext }),
    ).rejects.toThrow();
  });

  it('forward secrecy for removed members: after rotation a removed member cannot read new messages', async () => {
    const server = new FakeKeyServer();
    const alice = await client(server, ALICE, dev(1));
    const bob = await client(server, BOB, dev(2));

    await alice.encrypt(CHANNEL, [ALICE, BOB], { body: 'before' });
    await bob.sync();
    await alice.rotate(CHANNEL);
    const after = await alice.encrypt(CHANNEL, [ALICE], { body: 'after Bob left' });
    await bob.sync();
    await expect(
      bob.decrypt({ id: 'm2', channelId: CHANNEL, senderId: ALICE, createdAt: new Date().toISOString(), ciphertext: after.ciphertext }),
    ).rejects.toThrow();
  });

  it('tampering: a modified ciphertext is rejected', async () => {
    const server = new FakeKeyServer();
    const alice = await client(server, ALICE, dev(1));
    const bob = await client(server, BOB, dev(2));
    const sent = await alice.encrypt(CHANNEL, [ALICE, BOB], { body: 'pay 100' });
    await bob.sync();
    const content = JSON.parse(Buffer.from(sent.ciphertext, 'base64').toString('utf8')) as { ciphertext: string };
    const flipped = content.ciphertext.slice(0, 20) + (content.ciphertext[20] === 'A' ? 'B' : 'A') + content.ciphertext.slice(21);
    const forged = Buffer.from(JSON.stringify({ ...content, ciphertext: flipped })).toString('base64');
    await expect(
      bob.decrypt({ id: 'm1', channelId: CHANNEL, senderId: ALICE, createdAt: new Date().toISOString(), ciphertext: forged }),
    ).rejects.toThrow();
  });

  it('key backup: a new device restores history keys with the master passphrase only', async () => {
    const server = new FakeKeyServer();
    const alice = await client(server, ALICE, dev(1));
    const bob = await client(server, BOB, dev(2));
    const sent = await alice.encrypt(CHANNEL, [ALICE, BOB], { body: 'archived' });
    await bob.sync();
    await bob.enableBackup('correct horse battery staple');

    // Bob loses his laptop and signs in on a new device.
    const bobNew = await client(server, BOB, dev(4));
    await expect(bobNew.restoreBackup('wrong passphrase!!')).rejects.toThrow(/passphrase/);
    expect(await bobNew.restoreBackup('correct horse battery staple')).toBeGreaterThan(0);
    const got = await bobNew.decrypt({ id: 'm1', channelId: CHANNEL, senderId: ALICE, createdAt: new Date().toISOString(), ciphertext: sent.ciphertext });
    expect(got.content.body).toBe('archived');

    // The server holds only wrapped key material.
    expect(JSON.stringify([...server.secrets.values()])).not.toContain('correct horse');
  });

  it('QR verification marks the other device as verified', async () => {
    const server = new FakeKeyServer();
    const phone = await client(server, ALICE, dev(1));
    const laptop = await client(server, ALICE, dev(5));
    await phone.bootstrapCrossSigning();
    await laptop.sync();
    await phone.sync();

    const request = await laptop.requestOwnDeviceVerification(dev(1));
    await phone.sync();
    const incoming = phone.pendingVerification(mx(ALICE))!;
    expect(incoming).toBeDefined();
    await phone.acceptVerification(incoming);
    await laptop.sync();

    const bytes = await phone.showQr(incoming); // the phone shows a QR code
    const qr = await laptop.scanQr(request, bytes); // the laptop scans it
    await phone.sync();
    const shown = incoming.getVerification() as import('@matrix-org/matrix-sdk-crypto-wasm').Qr;
    expect(shown.hasBeenScanned()).toBe(true);
    await phone.confirmScanned(shown);
    await laptop.sync();
    await phone.sync();

    expect(qr.isDone()).toBe(true);
    expect(await laptop.isDeviceVerified(ALICE, dev(1))).toBe(true);
  });
});

describe('master passphrase wrapping (PBKDF2 + AES-256-GCM via WebCrypto)', () => {
  it('round-trips and rejects a wrong passphrase or tampering', async () => {
    const w = await wrapSecret('backup-key-material', 'a long master passphrase', 100_000);
    expect(await unwrapSecret(w, 'a long master passphrase')).toBe('backup-key-material');
    await expect(unwrapSecret(w, 'another long passphrase')).rejects.toThrow();
    const tampered = { ...w, ciphertext: w.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    await expect(unwrapSecret(tampered, 'a long master passphrase')).rejects.toThrow();
  });

  it('refuses short passphrases and downgraded iteration counts', async () => {
    await expect(wrapSecret('x', 'short')).rejects.toThrow();
    const w = await wrapSecret('x', 'a long master passphrase', 100_000);
    await expect(unwrapSecret({ ...w, iterations: 1000 }, 'a long master passphrase')).rejects.toThrow();
  });
});
