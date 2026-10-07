import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_VERSION } from '../src/core/version.js';

import { createTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ airports: false });
});
afterAll(() => t.close());

describe('GET /health', () => {
  it('reports mongo, scheduler and version without credentials', async () => {
    const res = await t.anon.get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ok',
      mongo: true,
      scheduler: { enabled: false, running: false, lastTickAt: null, jobs: [] },
      version: APP_VERSION,
      name: 'td-csq-backend',
    });
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies CORS for configured origins', async () => {
    const res = await t.anon.get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await t.anon.get('/api/v1/health').set('Origin', 'http://evil.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
