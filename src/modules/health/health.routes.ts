import { pingDb } from '../../core/db.js';
import { route } from '../../core/http.js';
import { scheduler } from '../../core/scheduler.js';
import { APP_NAME, APP_VERSION } from '../../core/version.js';

export const healthRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'public' },
    summary: 'Liveness: mongo ping, scheduler status, version',
    handler: async ({ res }) => {
      const mongo = await pingDb();
      if (!mongo) res.status(503);
      return {
        status: mongo ? 'ok' : 'degraded',
        mongo,
        scheduler: scheduler.status(),
        version: APP_VERSION,
        name: APP_NAME,
        uptimeSeconds: Math.round(process.uptime()),
        time: new Date().toISOString(),
      };
    },
  }),
];
