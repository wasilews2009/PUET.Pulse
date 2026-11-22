import { describe, expect, it } from 'vitest';
import type { Message } from '../src/api/types';
import { safeName, FILE_MSG, isPollEvent, parseFile, parsePoll, POLL_END, POLL_RESPONSE, POLL_START, sniffSafeType, tallyPoll } from '../src/features/chat/E2eeContent';

const msg = (id: string, senderId: string, at: number): Message =>
  ({ id, channelId: 'c', senderId, senderDeviceId: 'D', threadRootId: null, scheme: 'MEGOLM', body: null, ciphertext: 'x', isPriority: false, createdAt: new Date(Date.UTC(2026, 10, 22, 10, at)).toISOString(), editedAt: null, deleted: false }) as unknown as Message;

describe('encrypted room content', () => {
  it('malware: files are recognised by their bytes; executables and HTML are refused', () => {
    expect(sniffSafeType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffSafeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffSafeType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull(); // Windows executable
    expect(sniffSafeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBeNull(); // ZIP / macro documents
  });

  it('spoofing: content from other devices is validated field by field', () => {
    const file = { v: 'puet.aes-256-gcm.v1', key: 'k', iv: 'i', sha256: 'a'.repeat(64), blobId: '00000000-0000-4000-8000-000000000001' };
    expect(parseFile({ msgtype: FILE_MSG, body: 'Скарга.pdf', info: { mimetype: 'application/pdf', size: 10 }, file })?.name).toBe('Скарга.pdf');
    expect(parseFile({ msgtype: FILE_MSG, body: 'x.html', info: { mimetype: 'text/html', size: 10 }, file })).toBeNull();
    expect(parseFile({ msgtype: FILE_MSG, body: 'x.pdf', info: { mimetype: 'application/pdf', size: 10 }, file: { ...file, blobId: '../../admin' } })).toBeNull();
    expect(safeName('report.html', 'text/plain')).toBe('report.html.txt');
    expect(safeName('photo.JPG', 'image/jpeg')).toBe('photo.JPG');
    expect(parsePoll({ msgtype: POLL_START, question: 'Коли збори?', choices: [{ id: 'c1', text: 'Пн' }] })).toBeNull();
  });

  it('polls are tallied on the device: last vote per person counts, only the author ends the poll', () => {
    const poll = msg('p', 'author', 0);
    const ev = (id: string, who: string, at: number, content: Record<string, unknown>) => ({ m: msg(id, who, at), content });
    const events = [
      ev('1', 'a', 1, { msgtype: POLL_RESPONSE, poll: 'p', choice: 'c1' }),
      ev('2', 'b', 2, { msgtype: POLL_RESPONSE, poll: 'p', choice: 'c1' }),
      ev('3', 'a', 3, { msgtype: POLL_RESPONSE, poll: 'p', choice: 'c2' }),
      ev('4', 'c', 4, { msgtype: POLL_RESPONSE, poll: 'other', choice: 'c1' }),
      ev('5', 'b', 5, { msgtype: POLL_END, poll: 'p' }),
    ];
    const r = tallyPoll(poll, events);
    expect(Object.fromEntries(r.counts)).toEqual({ c1: 1, c2: 1 });
    expect(r.closed).toBe(false);
    expect(tallyPoll(poll, [...events, ev('6', 'author', 6, { msgtype: POLL_END, poll: 'p' })]).closed).toBe(true);
    expect(isPollEvent({ msgtype: POLL_RESPONSE })).toBe(true);
  });
});
