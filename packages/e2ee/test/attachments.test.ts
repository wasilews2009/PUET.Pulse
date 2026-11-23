import { describe, expect, it } from 'vitest';
import { AttachmentError, decryptAttachment, encryptAttachment } from '../src';

describe('encrypted attachments', () => {
  it('round-trips with a fresh key per file; the server copy is ciphertext only', async () => {
    const plain = new TextEncoder().encode('%PDF-1.7 Скарга до омбудсмена');
    const a = await encryptAttachment(plain);
    const b = await encryptAttachment(plain);
    expect(a.info.key).not.toBe(b.info.key);
    expect(Buffer.from(a.ciphertext).includes(Buffer.from(plain))).toBe(false);
    expect(new TextDecoder().decode(await decryptAttachment(a.ciphertext, a.info))).toBe('%PDF-1.7 Скарга до омбудсмена');
  });

  it('tampering: a swapped or altered blob, or a wrong key, is refused', async () => {
    const { ciphertext, info } = await encryptAttachment(new Uint8Array([1, 2, 3, 4, 5]));
    const other = await encryptAttachment(new Uint8Array([9, 9, 9]));
    await expect(decryptAttachment(other.ciphertext, info)).rejects.toBeInstanceOf(AttachmentError);
    const flipped = Uint8Array.from(ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    await expect(decryptAttachment(flipped, info)).rejects.toBeInstanceOf(AttachmentError);
    await expect(decryptAttachment(ciphertext, { ...info, key: other.info.key })).rejects.toBeInstanceOf(AttachmentError);
    await expect(decryptAttachment(ciphertext, { ...info, v: 'other' } as never)).rejects.toBeInstanceOf(AttachmentError);
  });
});
