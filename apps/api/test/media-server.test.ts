import { createHash } from 'node:crypto';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { LiveKitMediaServer } from '../src/calls/media-server';

const cfg = { url: 'http://127.0.0.1:7880', publicUrl: 'wss://meet.test', apiKey: 'pulse-test', apiSecret: 's'.repeat(40) };
const media = new LiveKitMediaServer(cfg);

/** What LiveKit sends: a JWT signed with the API secret that carries the body's SHA-256. */
async function signWebhook(body: string, secret = cfg.apiSecret) {
  const at = new AccessToken(cfg.apiKey, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

describe('LiveKit adapter (Phase 7)', () => {
  it('join tokens: one room, the user id as identity, no data channel, short TTL', async () => {
    const jwt = await media.joinToken({ room: 'pulse-abc', identity: 'user-1', canPublish: true, ttlSeconds: 300 });
    const claims = await new TokenVerifier(cfg.apiKey, cfg.apiSecret).verify(jwt);
    expect(claims.sub).toBe('user-1');
    expect(claims.video).toMatchObject({ roomJoin: true, room: 'pulse-abc', canPublish: true, canPublishData: false, canUpdateOwnMetadata: false });
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.roomCreate).toBeUndefined();
    expect((claims.exp as number) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    // The token carries no personal data besides the opaque id.
    expect(claims.name).toBeFalsy();
    expect(claims.metadata).toBeFalsy();
  });

  it('read-only members get a subscribe-only token', async () => {
    const jwt = await media.joinToken({ room: 'pulse-abc', identity: 'user-2', canPublish: false, ttlSeconds: 300 });
    const claims = await new TokenVerifier(cfg.apiKey, cfg.apiSecret).verify(jwt);
    expect(claims.video).toMatchObject({ canPublish: false, canSubscribe: true, canPublishSources: [] });
  });

  it('forged webhooks: a wrong secret or an altered body is rejected', async () => {
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'pulse-abc' }, participant: { identity: 'user-1' } });
    await expect(media.verifyWebhook(body, await signWebhook(body))).resolves.toEqual({ event: 'participant_joined', room: 'pulse-abc', identity: 'user-1' });
    await expect(media.verifyWebhook(body, await signWebhook(body, 'x'.repeat(40)))).rejects.toThrow();
    const altered = body.replace('user-1', 'user-9');
    await expect(media.verifyWebhook(altered, await signWebhook(body))).rejects.toThrow();
    await expect(media.verifyWebhook(body, undefined)).rejects.toThrow();
  });
});
