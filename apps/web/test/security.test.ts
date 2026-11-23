import { describe, expect, it } from 'vitest';
import type { Channel } from '../src/api/types';
import { isUuid } from '../src/api/client';
import { postingState } from '../src/features/chat/channel-utils';
import { en } from '../src/i18n/en';
import { uk } from '../src/i18n/uk';
import { safeReturnTo } from '../src/session/session';
import { applyOverrides, sanitizeOverrides } from '../src/theme/overrides';

const channel = (over: Partial<Channel>): Channel => ({
  id: '00000000-0000-4000-8000-000000000001',
  type: 'ACADEMIC_GROUP',
  e2eeMode: 'DISABLED',
  nameUk: 'Канал',
  nameEn: 'Channel',
  topic: null,
  isOfficial: false,
  confidential: false,
  threadsRequired: false,
  messageTtlSeconds: null,
  archived: false,
  peerId: null,
  role: 'MEMBER',
  lastReadAt: null,
  mutedUntil: null,
  unread: 0,
  ...over,
});

describe('white-label overrides', () => {
  it('CSS injection: only brand variables with plain hex colors are applied', () => {
    expect(
      sanitizeOverrides({
        '--puet-navy-primary': '#112233',
        'puet-terracotta-accent': '#AABBCC',
        '--puet-ice-surface': 'red; background: url(https://evil.example/x)',
        '--puet-ice-shadow': '#123',
        '--pulse-canvas': '#000000',
        color: '#000000',
      }),
    ).toEqual({ '--puet-navy-primary': '#112233', '--puet-terracotta-accent': '#AABBCC' });
  });

  it('CSS injection: non-object input is ignored', () => {
    for (const raw of [null, undefined, 'x', 42, ['#000000']]) expect(sanitizeOverrides(raw)).toEqual({});
  });

  it('applying new overrides clears the previous tenant palette', () => {
    const el = document.createElement('div');
    applyOverrides({ '--puet-navy-primary': '#112233' }, el);
    expect(el.style.getPropertyValue('--puet-navy-primary')).toBe('#112233');
    applyOverrides({}, el);
    expect(el.style.getPropertyValue('--puet-navy-primary')).toBe('');
  });
});

describe('login redirect', () => {
  it('open redirect: only same-site relative paths survive', () => {
    expect(safeReturnTo('/chats/abc?tab=files')).toBe('/chats/abc?tab=files');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});

describe('ids', () => {
  it('path injection: only UUIDs are used in API paths', () => {
    expect(isUuid('6f1c1d0e-8a4b-4c5d-9e2f-0123456789ab')).toBe(true);
    for (const bad of ['../admin', '6f1c1d0e-8a4b-4c5d-9e2f-0123456789ab/../x', '', undefined]) expect(isUuid(bad)).toBe(false);
  });
});

describe('posting state mirrors the server rules', () => {
  it('archived course channels are read-only', () => {
    expect(postingState(channel({ type: 'COURSE', archived: true, role: 'OWNER' }))).toBe('archived');
  });
  it('announcement and emergency channels accept posts only from moderators', () => {
    expect(postingState(channel({ type: 'ANNOUNCEMENT' }))).toBe('readOnly');
    expect(postingState(channel({ type: 'EMERGENCY', role: 'MODERATOR' }))).toBe('ok');
  });
  it('course threads: members reply in threads only', () => {
    expect(postingState(channel({ type: 'COURSE', threadsRequired: true }))).toBe('threadsOnly');
    expect(postingState(channel({ type: 'COURSE', threadsRequired: true, role: 'OWNER' }))).toBe('ok');
  });
  it('read-only members cannot post', () => {
    expect(postingState(channel({ role: 'READ_ONLY' }))).toBe('readOnly');
  });
});

describe('localization', () => {
  const keysOf = (o: object, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keysOf(v as object, `${p}${k}.`) : [`${p}${k}`]));
  it('uk and en have the same keys and no empty strings', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(uk).sort());
    const empty = (o: object): string[] => keysOf(o).filter((k) => k.split('.').reduce<unknown>((a, s) => (a as Record<string, unknown>)[s], o) === '');
    expect(empty(uk)).toEqual([]);
    expect(empty(en)).toEqual([]);
  });
});
