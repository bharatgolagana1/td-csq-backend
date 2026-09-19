import { defineModule, type ApiModule } from './router.js';
import type { Database } from '../db/connect.js';

/**
 * Liveness and readiness are different questions and must not share an answer.
 * /healthz says the process is running: if it fails the orchestrator restarts
 * the container. /readyz says it can serve: if it fails the load balancer stops
 * sending traffic but the process is left alone, which is what you want while
 * a database failover completes.
 */
export function healthModule(db: Database, startedAt: Date): ApiModule {
  return defineModule({
    name: 'health',
    basePath: '/',
    capabilities: [],
    routes: [
      {
        method: 'get',
        path: '/healthz',
        summary: 'Process liveness',
        policy: { requiredCapability: null, tenancy: 'PUBLIC' },
        handler: () => ({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000) }),
      },
      {
        method: 'get',
        path: '/readyz',
        summary: 'Readiness including the database',
        policy: { requiredCapability: null, tenancy: 'PUBLIC' },
        handler: async (_req, res) => {
          const mongo = await db.ping();
          res.status(mongo ? 200 : 503).json({ status: mongo ? 'ready' : 'degraded', mongo });
        },
      },
    ],
  });
}
