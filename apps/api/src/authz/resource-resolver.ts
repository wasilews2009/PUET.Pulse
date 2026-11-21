import type { Principal, Resource } from '@puet/policy-engine';
import type { ResourceType } from '@puet/shared';

export const RESOURCE_RESOLVERS = Symbol('RESOURCE_RESOLVERS');

/**
 * Loads a resource by id from the database together with the facts the policy
 * engine needs (tenant, owner, the caller's membership). Implementations MUST:
 *  - look the resource up by id only, never trust tenant/owner fields from the client;
 *  - compute membership for *this* principal from the membership table;
 *  - return null when the resource does not exist (the guard then denies).
 */
export interface ResourceResolver {
  readonly types: readonly ResourceType[];
  resolve(type: ResourceType, id: string | undefined, principal: Principal): Promise<Resource | null>;
}
