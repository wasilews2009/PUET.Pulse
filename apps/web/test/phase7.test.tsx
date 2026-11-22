import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Call, Channel, Slot } from '../src/api/types';

const ME = '00000000-0000-4000-8000-0000000000aa';
let callData: Call;

vi.mock('../src/session/session', () => ({ useMe: () => ({ userId: ME, kind: 'STUDENT', roles: [{ role: 'STUDENT', scope: {}, expiresAt: null }] }) }));
vi.mock('../src/api/queries', async (orig) => ({
  ...(await orig<typeof import('../src/api/queries')>()),
  useCard: () => ({ data: undefined }),
  useCall: () => ({ isPending: false, isError: false, data: callData }),
}));

const { canStartCall, roomOpen, canHostConsultations } = await import('../src/features/calls/call-utils');
const { CallProvider } = await import('../src/features/calls/CallContext');
const { CallCard } = await import('../src/features/calls/CallCard');
const { SlotCard } = await import('../src/features/consultations/SlotCard');

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CallProvider>{node}</CallProvider>
    </QueryClientProvider>,
  );

const channel = (over: Partial<Channel> = {}) =>
  ({ id: '00000000-0000-4000-8000-000000000001', type: 'ACADEMIC_GROUP', e2eeMode: 'DISABLED', role: 'MEMBER', archived: false, threadsRequired: false, ...over }) as unknown as Channel;

const slot = (over: Partial<Slot> = {}): Slot => ({
  id: '00000000-0000-4000-8000-000000000009',
  hostId: '00000000-0000-4000-8000-0000000000bb',
  startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 3 * 86_400_000 + 1_800_000).toISOString(),
  capacity: 2,
  booked: 1,
  mode: 'OFFLINE',
  location: 'ауд. 312 <img src=x onerror=alert(1)>',
  courseOfferingId: null,
  course: { nameUk: 'Комп’ютерні мережі', nameEn: 'Computer networks' },
  note: 'Підготовка до модульного контролю',
  status: 'ACTIVE',
  myBooking: null,
  bookings: null,
  bookable: true,
  callId: null,
  ...over,
});

describe('calls: who sees the call button', () => {
  it('mirrors the server: moderated channels, read-only, archived and mandatory E2EE', () => {
    expect(canStartCall(channel())).toBe(true);
    expect(canStartCall(channel({ type: 'COURSE' }))).toBe(false);
    expect(canStartCall(channel({ type: 'COURSE', role: 'MODERATOR' }))).toBe(true);
    expect(canStartCall(channel({ role: 'READ_ONLY' }))).toBe(false);
    expect(canStartCall(channel({ archived: true }))).toBe(false);
    expect(canStartCall(channel({ type: 'TRUST_ROOM', e2eeMode: 'MANDATORY', role: 'OWNER' }))).toBe(false);
    expect(canStartCall(channel({ type: 'DIRECT', e2eeMode: 'OPTIONAL' }))).toBe(true);
  });

  it('consultation rooms open 10 minutes early and close 15 minutes after', () => {
    const start = Date.parse('2026-11-23T10:00:00Z');
    const s = { startsAt: '2026-11-23T10:00:00Z', endsAt: '2026-11-23T10:30:00Z', status: 'ACTIVE' as const, mode: 'ONLINE' as const };
    expect(roomOpen(s, start - 11 * 60_000)).toBe(false);
    expect(roomOpen(s, start - 9 * 60_000)).toBe(true);
    expect(roomOpen(s, start + 44 * 60_000)).toBe(true);
    expect(roomOpen(s, start + 46 * 60_000)).toBe(false);
    expect(roomOpen({ ...s, mode: 'OFFLINE' }, start)).toBe(false);
    expect(roomOpen({ ...s, status: 'CANCELLED' }, start)).toBe(false);
  });

  it('only teaching staff host consultations', () => {
    const me = (kind: string, role: string) => ({ kind, roles: [{ role, scope: {}, expiresAt: null }] }) as never;
    expect(canHostConsultations(me('STAFF', 'LECTURER'))).toBe(true);
    expect(canHostConsultations(me('STAFF', 'ADMIN_STAFF'))).toBe(false);
    expect(canHostConsultations(me('STUDENT', 'STUDENT'))).toBe(false);
  });
});

describe('call card in the timeline', () => {
  it('a live call offers to join; an ended one shows its duration', () => {
    callData = { id: 'c1', kind: 'CHANNEL', channelId: channel().id, slotId: null, messageId: 'm1', startedById: ME, startedAt: '2026-11-22T09:00:00.000Z', endedAt: null, participants: [ME, 'u2'] };
    const live = wrap(<CallCard callId="c1" channel={channel()} />);
    expect(screen.getByRole('button', { name: 'Приєднатися' })).toBeInTheDocument();
    expect(screen.getByText(/Триває з .* · 2 учасники/)).toBeInTheDocument();
    live.unmount();
    callData = { ...callData, endedAt: '2026-11-22T09:42:00.000Z' };
    wrap(<CallCard callId="c1" channel={channel()} />);
    expect(screen.queryByRole('button', { name: 'Приєднатися' })).toBeNull();
    expect(screen.getByText(/Завершено · 42 хв · 2 учасники/)).toBeInTheDocument();
  });
});

describe('consultation slots', () => {
  it('a student sees free time to book, and slot text renders as text (XSS)', () => {
    const { container } = wrap(<SlotCard slot={slot()} view="browse" />);
    expect(screen.getByRole('button', { name: 'Записатися' })).toBeInTheDocument();
    expect(screen.getByText('Записано 1 з 2')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a slot of another course is shown but not bookable; a full one says so', () => {
    const other = wrap(<SlotCard slot={slot({ bookable: false })} view="browse" />);
    expect(screen.queryByRole('button', { name: 'Записатися' })).toBeNull();
    expect(screen.getByText('Запис для студентів дисципліни')).toBeInTheDocument();
    other.unmount();
    wrap(<SlotCard slot={slot({ bookable: false, booked: 2 })} view="browse" />);
    expect(screen.getByText('Місць немає')).toBeInTheDocument();
  });

  it('the host sees who booked and why; the online room opens only around the slot', () => {
    const now = Date.now();
    const soon = slot({
      mode: 'ONLINE',
      location: null,
      startsAt: new Date(now + 5 * 60_000).toISOString(),
      endsAt: new Date(now + 35 * 60_000).toISOString(),
      bookings: [{ id: 'b1', studentId: 'u-s1', topic: 'Лабораторна робота 3', createdAt: new Date(now).toISOString() }],
    });
    wrap(<SlotCard slot={soon} view="host" />);
    expect(screen.getByText('Лабораторна робота 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Увійти в кімнату' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скасувати консультацію' })).toBeInTheDocument();
  });

  it('a booked student sees their own topic and can cancel, but the room is closed days ahead', () => {
    wrap(<SlotCard slot={slot({ myBooking: { id: 'b1', studentId: ME, topic: 'Курсова', createdAt: new Date().toISOString() } })} view="booked" />);
    expect(screen.getByText('Тема: Курсова')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скасувати запис' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Увійти в кімнату' })).toBeNull();
  });
});
