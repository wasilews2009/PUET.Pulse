import { describe, expect, it } from 'vitest';
import { hiddenForMinor } from '../src/features/chat/MessageList';

describe('content filter on minors’ devices', () => {
  it('minor protection: obscene or outside-link E2EE messages are hidden for minors only', () => {
    expect(hiddenForMinor(true, { text: 'ти х у й', encrypted: true })).toBe(true);
    expect(hiddenForMinor(true, { text: 'https://casino.example', encrypted: true })).toBe(true);
    expect(hiddenForMinor(true, { text: 'Домашнє завдання на понеділок', encrypted: true })).toBe(false);
    // Adults see everything; plaintext channels are already filtered by the API.
    expect(hiddenForMinor(false, { text: 'ти х у й', encrypted: true })).toBe(false);
    expect(hiddenForMinor(true, { text: 'ти х у й', encrypted: false })).toBe(false);
  });
});
