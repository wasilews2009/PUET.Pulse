import { useSyncExternalStore } from 'react';

/** Who is typing where; entries expire after 6 seconds without a new event. */
const state = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, string[]>();

function emit() {
  const now = Date.now();
  const next = new Map<string, string[]>();
  for (const [ch, users] of state) {
    for (const [u, until] of users) if (until <= now) users.delete(u);
    if (users.size) next.set(ch, [...users.keys()]);
  }
  snapshot = next;
  for (const l of listeners) l();
}

export const typingStore = {
  start(channelId: string, userId: string) {
    const m = state.get(channelId) ?? new Map<string, number>();
    m.set(userId, Date.now() + 6000);
    state.set(channelId, m);
    emit();
    setTimeout(emit, 6100);
  },
  stop(channelId: string, userId: string) {
    if (state.get(channelId)?.delete(userId)) emit();
  },
};

export function useTyping(channelId: string): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot.get(channelId) ?? EMPTY,
  );
}
const EMPTY: string[] = [];
