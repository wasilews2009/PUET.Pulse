import type { Decision, Principal, Resource } from '@puet/policy-engine';

/** Set by the authentication layer (OIDC session middleware, Phase 2). Never by the client. */
export interface RequestAuthContext {
  principal?: Principal;
  requestId?: string;
  /** Filled by PolicyGuard: the resource that was authorized, so handlers do not re-query by raw id. */
  authz?: { resource: Resource; decision: Decision };
}

export type AuthenticatedRequest = RequestAuthContext & {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};

/** Socket.io client shape used by the WebSocket gateway (Phase 3). */
export interface AuthenticatedSocket {
  data: RequestAuthContext;
  handshake?: { address?: string };
}
