import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../api/client";
import type { CallJoin } from "../../api/types";

// livekit-client is large: it is loaded only when somebody joins a call.
const CallRoom = lazy(() => import("./CallRoom"));

export type CallTarget =
  | { kind: "call"; callId: string }
  | { kind: "slot"; slotId: string };

export interface CallOptions {
  title: string;
  /** Shown in the room, e.g. that media is encrypted in transit but not end to end. */
  notice?: string | null;
  /** The caller may end the call for everybody (starter, moderator or host). */
  canEnd?: boolean;
}

interface Active extends CallOptions {
  join: CallJoin;
}

interface CallApi {
  active: Active | null;
  join: (target: CallTarget, opts: CallOptions) => Promise<void>;
  leave: () => void;
}

const Ctx = createContext<CallApi | null>(null);

export function useCalls(): CallApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCalls outside CallProvider");
  return c;
}

/** One call at a time, shown over the whole app so chats stay usable underneath. */
export function CallProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);

  const join = useCallback(async (target: CallTarget, opts: CallOptions) => {
    const path =
      target.kind === "call"
        ? `/calls/${target.callId}/join`
        : `/consultations/slots/${target.slotId}/join`;
    const info = await api<CallJoin>(path, { method: "POST" });
    setActive({ ...opts, join: info });
  }, []);
  const leave = useCallback(() => setActive(null), []);
  const value = useMemo(() => ({ active, join, leave }), [active, join, leave]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {active && (
        <Suspense fallback={null}>
          <CallRoom
            key={active.join.callId + active.join.token}
            {...active}
            onLeave={leave}
          />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}
