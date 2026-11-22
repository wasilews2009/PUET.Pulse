import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ApprovalRoute, Channel, FileItem, Member, Message, UserCard } from './types';

export const keys = {
  channels: ['channels'] as const,
  messages: (channelId: string, threadRootId?: string | null) => ['messages', channelId, threadRootId ?? 'top'] as const,
  members: (channelId: string) => ['members', channelId] as const,
  files: (channelId: string) => ['files', channelId] as const,
  card: (userId: string) => ['card', userId] as const,
  approvals: ['approvals'] as const,
  routes: (fileId: string) => ['routes', fileId] as const,
  signatures: (fileId: string) => ['signatures', fileId] as const,
  verification: (fileId: string) => ['verification', fileId] as const,
  file: (fileId: string) => ['file', fileId] as const,
  certificates: ['certificates'] as const,
};

export const useChannels = () => useQuery({ queryKey: keys.channels, queryFn: () => api<Channel[]>('/me/channels'), staleTime: 30_000 });

export const PAGE = 50;

/** Newest first from the API; pages go back in time with `before`. */
export function useMessages(channelId: string, threadRootId?: string | null) {
  return useInfiniteQuery({
    queryKey: keys.messages(channelId, threadRootId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (pageParam) q.set('before', pageParam);
      if (threadRootId) q.set('threadRootId', threadRootId);
      return api<Message[]>(`/channels/${channelId}/messages?${q}`);
    },
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last.at(-1)?.createdAt),
  });
}

export const useMembers = (channelId: string) =>
  useQuery({ queryKey: keys.members(channelId), queryFn: () => api<Member[]>(`/channels/${channelId}/members`), staleTime: 60_000 });

export const useFiles = (channelId: string) =>
  useQuery({ queryKey: keys.files(channelId), queryFn: () => api<FileItem[]>(`/channels/${channelId}/files`) });

export const useApprovals = () => useQuery({ queryKey: keys.approvals, queryFn: () => api<ApprovalRoute[]>('/me/approvals') });

/**
 * People cards are fetched in batches (POST /directory/cards). The server drops
 * anyone the caller may not see (minor protection, guests, other tenants);
 * those resolve to null and render as a hidden user.
 */
let pending = new Map<string, ((c: UserCard | null) => void)[]>();
let scheduled = false;

function flush() {
  scheduled = false;
  const batch = pending;
  pending = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    api<UserCard[]>('/directory/cards', { method: 'POST', body: { userIds: chunk } })
      .then((cards) => {
        const by = new Map(cards.map((c) => [c.id, c]));
        for (const id of chunk) for (const cb of batch.get(id) ?? []) cb(by.get(id) ?? null);
      })
      .catch(() => {
        // Guests have no directory (403): everyone stays anonymous, which is intended.
        for (const id of chunk) for (const cb of batch.get(id) ?? []) cb(null);
      });
  }
}

export function fetchCard(userId: string): Promise<UserCard | null> {
  return new Promise((resolve) => {
    const list = pending.get(userId) ?? [];
    list.push(resolve);
    pending.set(userId, list);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}

export const useCard = (userId: string | null | undefined) =>
  useQuery({
    queryKey: keys.card(userId ?? 'none'),
    queryFn: () => fetchCard(userId!),
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });

/** Insert or replace a message in the cached timeline (newest first). */
export function upsertMessage(qc: QueryClient, m: Message) {
  const key = keys.messages(m.channelId, m.threadRootId);
  let existed = false;
  qc.setQueryData<{ pages: Message[][]; pageParams: unknown[] }>(key, (data) => {
    if (!data) return data;
    let found = false;
    const pages = data.pages.map((p) =>
      p.map((x) => {
        if (x.id === m.id) {
          found = true;
          existed = true;
          return { ...x, ...m };
        }
        return x;
      }),
    );
    if (!found && pages[0]) {
      pages[0] = [m, ...pages[0]];
    }
    return { ...data, pages };
  });
  if (!existed && m.threadRootId && !m.deleted) {
    // Bump the reply counter on the thread root.
    qc.setQueryData<{ pages: Message[][]; pageParams: unknown[] }>(keys.messages(m.channelId, null), (data) =>
      data
        ? { ...data, pages: data.pages.map((p) => p.map((x) => (x.id === m.threadRootId ? { ...x, replyCount: (x.replyCount ?? 0) + 1 } : x))) }
        : data,
    );
  }
}

/** Marks a message deleted wherever it is cached (timeline or thread); never inserts it. */
export function markDeleted(qc: QueryClient, channelId: string, id: string) {
  for (const [key] of qc.getQueriesData({ queryKey: ['messages', channelId] })) {
    qc.setQueryData<{ pages: Message[][]; pageParams: unknown[] }>(key, (data) =>
      data ? { ...data, pages: data.pages.map((p) => p.map((x) => (x.id === id ? { ...x, deleted: true, body: null, ciphertext: null } : x))) } : data,
    );
  }
}
