import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'puet:isPublic';

/**
 * Marks a route as reachable without authentication (health checks, OIDC callback).
 * Every other route is denied unless it also carries @Authorize().
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
