import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type {
  AdmissionsDoc,
  ApprovalRoute,
  BotMessage,
  BotSlug,
  BotSummary,
  Call,
  Channel,
  ConsultationHost,
  DocumentRequest,
  FileItem,
  Member,
  Message,
  Poll,
  ScheduleChange,
  Slot,
  StudyPlan,
  Ticket,
  UserCard,
} from './types';

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
  poll: (pollId: string) => ['poll', pollId] as const,
  acks: (messageId: string) => ['acks', messageId] as const,
  call: (callId: string) => ['call', callId] as const,
  /** Every consultation list lives under this prefix, so one invalidation refreshes all. */
  consultations: ['consultations'] as const,
  myConsultations: ['consultations', 'mine'] as const,
  hostSlots: (userId: string) => ['consultations', 'host', userId] as const,
  hosts: ['consultations', 'hosts'] as const,
  myCourses: ['consultations', 'courses'] as const,
  /** Every bot query lives under this prefix. */
  bots: ['bots'] as const,
  botMessages: (bot: BotSlug) => ['bots', 'messages', bot] as const,
  docRequests: ['bots', 'deanery', 'requests'] as const,
  studyPlan: ['bots', 'deanery', 'plan'] as const,
  schedule: ['bots', 'schedule'] as const,
  myTickets: ['bots', 'tickets', 'mine'] as const,
  ticketQueue: (status: 'open' | 'closed') => ['bots', 'tickets', 'queue', status] as const,
  ticket: (id: string) => ['bots', 'tickets', id] as const,
  admissionsKb: ['bots', 'admissions', 'kb'] as const,
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

export const usePoll = (pollId: string) => useQuery({ queryKey: keys.poll(pollId), queryFn: () => api<Poll>(`/polls/${pollId}`), staleTime: 15_000 });

export const useCall = (callId: string) => useQuery({ queryKey: keys.call(callId), queryFn: () => api<Call>(`/calls/${callId}`), staleTime: 15_000 });

export const useMyConsultations = () =>
  useQuery({ queryKey: keys.myConsultations, queryFn: () => api<{ hosting: Slot[]; booked: Slot[] }>('/consultations/mine'), staleTime: 30_000 });

export const useHostSlots = (userId: string, enabled = true) =>
  useQuery({ queryKey: keys.hostSlots(userId), queryFn: () => api<Slot[]>(`/users/${userId}/consultations`), enabled, staleTime: 30_000 });

export const useConsultationHosts = () => useQuery({ queryKey: keys.hosts, queryFn: () => api<ConsultationHost[]>('/consultations/hosts'), staleTime: 300_000 });

export const useMyCourses = (enabled: boolean) =>
  useQuery({ queryKey: keys.myCourses, queryFn: () => api<{ id: string; nameUk: string; nameEn: string }[]>('/consultations/courses'), enabled, staleTime: 300_000 });

export const useBots = () => useQuery({ queryKey: keys.bots, queryFn: () => api<BotSummary[]>('/bots'), staleTime: 30_000 });

export const useBotMessages = (bot: BotSlug) =>
  useQuery({ queryKey: keys.botMessages(bot), queryFn: () => api<BotMessage[]>(`/bots/${bot}/messages`), staleTime: 15_000 });

export const useDocRequests = () => useQuery({ queryKey: keys.docRequests, queryFn: () => api<DocumentRequest[]>('/deanery/requests') });
export const useStudyPlan = () => useQuery({ queryKey: keys.studyPlan, queryFn: () => api<StudyPlan[]>('/deanery/study-plan') });
export const useScheduleChanges = () => useQuery({ queryKey: keys.schedule, queryFn: () => api<ScheduleChange[]>('/schedule/changes') });
export const useMyTickets = () => useQuery({ queryKey: keys.myTickets, queryFn: () => api<Ticket[]>('/service-desk/tickets/mine') });
export const useTicket = (id: string | null) =>
  useQuery({ queryKey: keys.ticket(id ?? 'none'), queryFn: () => api<Ticket>(`/service-desk/tickets/${id}`), enabled: !!id });

/** Queries that only some people may run: a 403 means "not for you" and hides the section. */
const forbiddenIsNull = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return null;
    throw e;
  }
};
export const useTicketQueue = (status: 'open' | 'closed') =>
  useQuery({ queryKey: keys.ticketQueue(status), queryFn: () => forbiddenIsNull(api<Ticket[]>(`/service-desk/queue?status=${status}`)), retry: false });
export const useAdmissionsKb = () =>
  useQuery({ queryKey: keys.admissionsKb, queryFn: () => forbiddenIsNull(api<AdmissionsDoc[]>('/bots/admissions/kb')), retry: false, staleTime: 60_000 });
