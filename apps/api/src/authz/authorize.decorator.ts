import { SetMetadata } from '@nestjs/common';
import type { Action, ResourceType } from '@puet/shared';

export const AUTHORIZE_KEY = 'puet:authorize';

export interface ResourceRef {
  type: ResourceType;
  /**
   * Name of the field holding the resource id. Looked up in route params, then
   * query (HTTP), or in the event payload (WebSocket). Omit for tenant-level
   * resources (directory, structure, audit), which resolve to the caller's tenant.
   */
  idField?: string;
  /**
   * Ids are UUIDs unless the route names a closed vocabulary instead (e.g. a bot slug).
   * The pattern must be anchored and match only values the resolver knows.
   */
  idPattern?: RegExp;
}

export interface AuthorizeMetadata {
  action: Action;
  resource: ResourceRef;
}

/**
 * Declares the action and the resource a route or WebSocket handler acts on.
 * PolicyGuard denies any non-public handler that lacks this decorator.
 *
 * @example
 *   @Get(':channelId')
 *   @Authorize(Action.CHANNEL_READ, { type: ResourceType.CHANNEL, idField: 'channelId' })
 */
export const Authorize = (action: Action, resource: ResourceRef) =>
  SetMetadata(AUTHORIZE_KEY, { action, resource } satisfies AuthorizeMetadata);
