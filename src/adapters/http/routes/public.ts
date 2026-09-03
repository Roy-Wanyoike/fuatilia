/**
 * Public (no-auth) routes mounted in this PR (issue #55): liveness + the
 * versioned capability list. No permission → the kernel never attempts
 * authentication on them, and `ctx.principal` stays null.
 */
import type { RouteRecord } from '../kernel/types';

export const SERVICE_NAME = 'fuatilia';
export const API_VERSION = 'v1';

/** GET /v1/health — liveness probe. */
export const healthRoute = (): RouteRecord => ({
  method: 'GET',
  pattern: '/v1/health',
  handler: () => ({ status: 200, data: { status: 'ok' } }),
});

/**
 * GET /v1/meta — service name, API version and the mounted capability list
 * (derived from the route table at composition — later waves that mount more
 * resources surface here without touching this file).
 */
export const metaRoute = (capabilities: readonly string[]): RouteRecord => ({
  method: 'GET',
  pattern: '/v1/meta',
  handler: () => ({
    status: 200,
    data: { name: SERVICE_NAME, apiVersion: API_VERSION, capabilities: [...capabilities] },
  }),
});
