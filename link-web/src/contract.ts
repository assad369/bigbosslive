import { DEEP_LINK_ROUTES, type DeepLinkKind } from '@bigboss/shared';

export type LinkRoute = (typeof DEEP_LINK_ROUTES)[number];
export type { DeepLinkKind };

/** Share-link routes by their first path segment (`DEEP_LINK_ROUTES` is the source of truth). */
export const byPrefix = new Map<string, LinkRoute>(DEEP_LINK_ROUTES.map((r) => [r.prefix, r]));
export const ROUTES = DEEP_LINK_ROUTES;
