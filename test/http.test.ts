// core/http `route()`, error envelopes, link policies and the module registry
// validation. No database needed.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createLinkSessions } from '../src/core/auth/link.js';
import { AppError, errorHandler, notFoundHandler } from '../src/core/errors.js';
import { buildRouter, route, type RouteDeps } from '../src/core/http.js';
import { defineModule } from '../src/core/module.js';
import { listQuerySchema, pageOf } from '../src/core/pagination.js';
import { requestId } from '../src/core/request-id.js';
import { routeTable, validateModules } from '../src/modules/index.js';

import { fakeVerifyToken } from './helpers/app.js';
import { expectError } from './helpers/fixtures.js';

const links = createLinkSessions('test-link-session-secret-0123456789abcdef');
const deps: RouteDeps = { verifyToken: fakeVerifyToken, links };

const routes = [
  route({
    method: 'post',
    path: '/things',
    policy: { kind: 'public' },
    body: z.object({ name: z.string().min(2), count: z.number().int().optional() }).strict(),
    status: 201,
    handler: ({ body }) => ({ created: body.name, count: body.count ?? 0 }),
  }),
  route({
    method: 'get',
    path: '/things',
    policy: { kind: 'public' },
    query: listQuerySchema.extend({ flag: z.stringbool().optional() }),
    response: z.array(z.object({ id: z.number() })),
    handler: ({ query }) => pageOf([{ id: 1, secret: 'stripped' }, { id: 2 }], 2, query),
  }),
  route({
    method: 'get',
    path: '/things/:id',
    policy: { kind: 'public' },
    params: z.object({ id: z.coerce.number().int() }),
    handler: ({ params }) => {
      if (params.id === 404) throw new AppError('NOT_FOUND', 'Thing not found');
      if (params.id === 409) throw new AppError('CONFLICT', 'Thing exists', { id: params.id });
      if (params.id === 500) throw new Error('boom with a stack');
      return { id: params.id };
    },
  }),
  route({ method: 'delete', path: '/things/:id', policy: { kind: 'public' }, handler: () => undefined }),
  route({
    method: 'get',
    path: '/participant',
    policy: { kind: 'link', audience: 'participant' },
    handler: ({ link }) => ({ subject: link.subject, audience: link.audience, inv: link.claims['inv'] }),
  }),
  route({ method: 'get', path: '/secure', policy: { kind: 'task', task: 'x.view' }, handler: () => ({ ok: true }) }),
];

function app(): express.Express {
  const instance = express();
  instance.use(requestId());
  instance.use(express.json());
  instance.use(buildRouter(routes, deps));
  instance.use(notFoundHandler());
  instance.use(errorHandler());
  return instance;
}

describe('route()', () => {
  it('validates the body and renders the VALIDATION envelope', async () => {
    const res = await request(app()).post('/things').send({ name: 'a', extra: true });
    const error = expectError(res, 400, 'VALIDATION');
    expect(error.message).toBe('Invalid body');
    const details = error.details as { in: string; issues: { path: string; message: string }[] };
    expect(details.in).toBe('body');
    expect(details.issues.map((i) => i.path).sort()).toEqual(['', 'name']);
  });

  it('wraps a payload in { data } with the declared status', async () => {
    const res = await request(app()).post('/things').send({ name: 'crate' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { created: 'crate', count: 0 } });
  });

  it('serialises a Page as { data, meta }, coerces the query and strips with the response schema', async () => {
    const res = await request(app()).get('/things?page=2&pageSize=5&flag=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: 1 }, { id: 2 }], meta: { page: 2, pageSize: 5, total: 2 } });
  });

  it('rejects an invalid query', async () => {
    const res = await request(app()).get('/things?pageSize=0');
    expect(expectError(res, 400, 'VALIDATION').message).toBe('Invalid query');
  });

  it('responds 204 when the handler returns nothing', async () => {
    const res = await request(app()).delete('/things/1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('maps AppError codes to statuses and keeps details', async () => {
    expect(expectError(await request(app()).get('/things/404'), 404, 'NOT_FOUND').message).toBe('Thing not found');
    const conflict = expectError(await request(app()).get('/things/409'), 409, 'CONFLICT');
    expect(conflict.details).toEqual({ id: 409 });
  });

  it('hides unexpected errors behind INTERNAL and echoes the request id', async () => {
    const res = await request(app()).get('/things/500').set('x-request-id', 'req-abc-123');
    const error = expectError(res, 500, 'INTERNAL');
    expect(error.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('stack');
    expect(error.requestId).toBe('req-abc-123');
    expect(res.headers['x-request-id']).toBe('req-abc-123');
  });

  it('404s unknown routes and malformed JSON is a VALIDATION error', async () => {
    expectError(await request(app()).get('/nothing'), 404, 'NOT_FOUND');
    const res = await request(app()).post('/things').set('Content-Type', 'application/json').send('{bad json');
    expect(expectError(res, 400, 'VALIDATION').message).toBe('Malformed JSON body');
  });

  it('requires a bearer token for task routes before touching anything else', async () => {
    expectError(await request(app()).get('/secure'), 401, 'UNAUTHENTICATED');
    expectError(await request(app()).get('/secure').set('Authorization', 'Bearer not-a-test-token'), 401, 'UNAUTHENTICATED');
    expectError(await request(app()).get('/secure').set('Authorization', 'Basic abc'), 401, 'UNAUTHENTICATED');
  });
});

describe('link policy', () => {
  it('accepts a signed participant session and exposes its claims', async () => {
    const token = await links.sign({ audience: 'participant', subject: 'inv-1', claims: { inv: 'inv-1', aco: 'a' }, ttlSeconds: 60 });
    const res = await request(app()).get('/participant').set('x-csq-link-token', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ subject: 'inv-1', audience: 'participant', inv: 'inv-1' });
  });

  it('rejects a missing header, the wrong audience, a tampered token and an expired one', async () => {
    expectError(await request(app()).get('/participant'), 401, 'UNAUTHENTICATED');
    const registration = await links.sign({ audience: 'registration', subject: 'r-1', ttlSeconds: 60 });
    expectError(await request(app()).get('/participant').set('x-csq-link-token', registration), 401, 'UNAUTHENTICATED');
    const good = await links.sign({ audience: 'participant', subject: 'inv-1', ttlSeconds: 60 });
    expectError(await request(app()).get('/participant').set('x-csq-link-token', `${good}x`), 401, 'UNAUTHENTICATED');
    const expired = await links.sign({ audience: 'participant', subject: 'inv-1', ttlSeconds: -120 });
    expectError(await request(app()).get('/participant').set('x-csq-link-token', expired), 410, 'LINK_EXPIRED');
  });

  it('rejects tokens signed with another secret', async () => {
    const other = createLinkSessions('another-secret-that-is-long-enough-123456');
    const token = await other.sign({ audience: 'participant', subject: 'inv-1', ttlSeconds: 60 });
    expectError(await request(app()).get('/participant').set('x-csq-link-token', token), 401, 'UNAUTHENTICATED');
  });
});

describe('module registry validation', () => {
  const ok = defineModule({
    name: 'demo',
    basePath: '/demo',
    tasks: [{ code: 'demo.view', name: 'View', description: '' }],
    routes: [route({ method: 'get', path: '/', policy: { kind: 'task', task: 'demo.view' }, handler: () => ({}) })],
  });

  it('accepts a consistent module and lists its routes', () => {
    expect(() => validateModules([ok])).not.toThrow();
    expect(routeTable([ok])).toEqual([{ module: 'demo', method: 'GET', path: '/api/v1/demo', policy: 'demo.view', summary: '' }]);
  });

  it('refuses a route that names a task its module did not declare', () => {
    const bad = defineModule({
      ...ok,
      routes: [route({ method: 'get', path: '/x', policy: { kind: 'task', task: 'other.view' }, handler: () => ({}) })],
    });
    expect(() => validateModules([bad])).toThrow(/does not declare/);
  });

  it('refuses a route without a policy, duplicate tasks and duplicate routes', () => {
    const noPolicy = defineModule({ ...ok, routes: [{ ...ok.routes[0]!, policy: undefined as never }] });
    expect(() => validateModules([noPolicy])).toThrow(/has no policy/);
    const dupTask = defineModule({ ...ok, name: 'demo2', basePath: '/demo2' });
    expect(() => validateModules([ok, dupTask])).toThrow(/already declared/);
    const dupRoute = defineModule({ ...ok, routes: [ok.routes[0]!, ok.routes[0]!] });
    expect(() => validateModules([dupRoute])).toThrow(/duplicate route/);
    const badCode = defineModule({ ...ok, tasks: [{ code: 'Demo-View', name: 'x', description: '' }] });
    expect(() => validateModules([badCode])).toThrow(/module\.verb/);
  });

  it('the real registry is consistent', () => {
    expect(() => validateModules()).not.toThrow();
    const table = routeTable();
    expect(table.every((r) => r.policy.length > 0)).toBe(true);
    expect(table.find((r) => r.path === '/api/v1/health')?.policy).toBe('public');
  });
});
