import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseAirportsCsv } from '../src/modules/airports/airports.csv.js';
import { AirportModel } from '../src/modules/airports/airports.model.js';
import { PHASE_I_IATA } from '../src/modules/airports/airports.regions.js';
import { seedAirports } from '../src/modules/airports/airports.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { createTestOperator, expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let analyst: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST' });
});
afterAll(() => t.close());

describe('seed', () => {
  it('loads the vendored list with the 14 Phase-I airports active and is idempotent', async () => {
    expect(await AirportModel.countDocuments()).toBe(116);
    const active = await AirportModel.find({ active: true }).lean();
    expect(active.map((a) => a.iata).sort()).toEqual([...PHASE_I_IATA].sort());
    expect(active.every((a) => a.region.length > 0 && a.state.length > 0 && a.country === 'IN')).toBe(true);
    const again = await seedAirports();
    expect(again).toEqual({ rows: 116, inserted: 0, errors: 0 });
  });

  it('does not clobber an edited row on re-seed', async () => {
    await AirportModel.updateOne({ iata: 'DEL' }, { $set: { name: 'Edited Name' } });
    await seedAirports();
    expect((await AirportModel.findOne({ iata: 'DEL' }).lean())?.name).toBe('Edited Name');
    await AirportModel.updateOne({ iata: 'DEL' }, { $set: { name: 'Indira Gandhi International Airport' } });
  });
});

describe('GET /airports', () => {
  it('lists with active, region, state and q filters', async () => {
    const active = await analyst.get('/api/v1/airports?active=true&pageSize=50');
    expect(active.status).toBe(200);
    expect(active.body.meta.total).toBe(14);
    const south = await analyst.get('/api/v1/airports?region=South&active=true');
    expect((south.body.data as { iata: string }[]).map((a) => a.iata).sort()).toEqual(['BLR', 'COK', 'HYD', 'MAA', 'TRV']);
    const kerala = await analyst.get('/api/v1/airports?state=Kerala');
    expect((kerala.body.data as { iata: string }[]).map((a) => a.iata).sort()).toEqual(['CCJ', 'CNN', 'COK', 'TRV']);
    const q = await analyst.get('/api/v1/airports?q=delhi');
    expect((q.body.data as { iata: string }[]).map((a) => a.iata)).toEqual(['DEL']);
    expectError(await analyst.get('/api/v1/airports?region=Mars'), 400, 'VALIDATION');
  });

  it('gets one airport; unknown is 404 and a malformed id is 400', async () => {
    const del = await AirportModel.findOne({ iata: 'DEL' }).lean();
    const res = await analyst.get(`/api/v1/airports/${del!._id.toHexString()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ iata: 'DEL', icao: 'VIDP', city: 'New Delhi', region: 'North', active: true, operators: [] });
    expectError(await analyst.get('/api/v1/airports/0123456789abcdef01234567'), 404, 'NOT_FOUND');
    expectError(await analyst.get('/api/v1/airports/DEL'), 400, 'VALIDATION');
  });

  it('carries operatorCount: the ACTIVE operators at each airport, on the list rows and on one airport', async () => {
    await createTestOperator({ code: 'APT-A', airportIata: 'DEL' });
    await createTestOperator({ code: 'APT-B', airportIata: 'DEL' });
    await createTestOperator({ code: 'APT-C', airportIata: 'DEL', status: 'INACTIVE' });
    await createTestOperator({ code: 'APT-D', airportIata: 'BOM' });

    const list = await analyst.get('/api/v1/airports?active=true&pageSize=50');
    expect(list.status).toBe(200);
    const counts = Object.fromEntries((list.body.data as { iata: string; operatorCount: number }[]).map((a) => [a.iata, a.operatorCount]));
    expect(counts).toMatchObject({ DEL: 2, BOM: 1, HYD: 0 });
    expect(Object.values(counts).every((count) => Number.isInteger(count))).toBe(true);

    const del = await AirportModel.findOne({ iata: 'DEL' }).lean();
    const one = await analyst.get(`/api/v1/airports/${del!._id.toHexString()}`);
    expect(one.status).toBe(200);
    expect(one.body.data.operatorCount).toBe(2);
    expect((one.body.data.operators as { code: string }[]).map((o) => o.code)).toEqual(expect.arrayContaining(['APT-A', 'APT-B']));
  });
});

describe('POST/PATCH /airports', () => {
  it('creates with a derived region, rejects duplicates and unknown states', async () => {
    const res = await superAdmin.post('/api/v1/airports').send({ iata: 'zzz', name: 'Test Field', city: 'Testville', state: 'Goa', lat: 15.1, lng: 73.9 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ iata: 'ZZZ', icao: null, region: 'West', active: false, country: 'IN' });
    expectError(await superAdmin.post('/api/v1/airports').send({ iata: 'ZZZ', name: 'Dup', city: 'x', state: 'Goa', lat: 1, lng: 1 }), 409, 'CONFLICT');
    const unknown = await superAdmin.post('/api/v1/airports').send({ iata: 'ZZY', name: 'x', city: 'x', state: 'Atlantis', lat: 1, lng: 1 });
    expect(expectError(unknown, 400, 'VALIDATION').message).toContain('No region known');
    expectError(await superAdmin.post('/api/v1/airports').send({ iata: 'ZZ', name: 'x', city: 'x', state: 'Goa', lat: 1, lng: 1 }), 400, 'VALIDATION');
    expectError(await analyst.post('/api/v1/airports').send({ iata: 'ZZX', name: 'x', city: 'x', state: 'Goa', lat: 1, lng: 1 }), 403, 'FORBIDDEN');
  });

  it('patches fields and re-derives the region when the state changes', async () => {
    const zzz = await AirportModel.findOne({ iata: 'ZZZ' }).lean();
    const res = await superAdmin.patch(`/api/v1/airports/${zzz!._id.toHexString()}`).send({ active: true, state: 'Assam', icao: 'vezz' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ active: true, state: 'Assam', region: 'North-East', icao: 'VEZZ' });
    expectError(await superAdmin.patch(`/api/v1/airports/${zzz!._id.toHexString()}`).send({ iata: 'AAA' }), 400, 'VALIDATION');
  });
});

describe('POST /airports/import', () => {
  const csv = [
    '# a comment line',
    'iata,icao,name,city,state,region,lat,lng,active',
    'DEL,VIDP,Indira Gandhi International Airport,New Delhi,Delhi,,28.5,77.1,true',
    'NEW,,Brand New Airport,Newtown,Karnataka,,12.5,77.5,',
    'BAD,,Missing City,,Nowhere,,1,2,',
    'NEW,,Duplicate In File,Newtown,Karnataka,,12.5,77.5,',
  ].join('\n');

  it('parses comments, derives regions and reports bad rows', () => {
    const parsed = parseAirportsCsv(csv);
    expect(parsed.total).toBe(4);
    expect(parsed.rows.map((r) => r.iata)).toEqual(['DEL', 'NEW']);
    expect(parsed.rows[1]).toMatchObject({ region: 'South', icao: undefined, active: undefined });
    // Region derivation runs only for rows whose fields all parsed, so row 3 reports city alone.
    expect(parsed.errors.map((e) => `${e.row}:${e.field}`)).toEqual(['3:city', '4:iata']);
    expect(parseAirportsCsv('iata,name,city,state,lat,lng\nZZZ,Field,Town,Atlantis,1,2\n').errors).toEqual([
      { row: 1, field: 'region', message: 'no region known for state "Atlantis"; supply one' },
    ]);
  });

  it('upserts via multipart upload and returns counts', async () => {
    const res = await superAdmin.post('/api/v1/airports/import').attach('file', Buffer.from(csv), 'airports.csv');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rows: 4, inserted: 1, updated: 1, rejected: 2 });
    expect(res.body.data.errors).toHaveLength(2);
    const created = await AirportModel.findOne({ iata: 'NEW' }).lean();
    expect(created).toMatchObject({ name: 'Brand New Airport', region: 'South', active: false, icao: null });
    expect((await AirportModel.findOne({ iata: 'DEL' }).lean())?.lat).toBe(28.5);
    await AirportModel.updateOne({ iata: 'DEL' }, { $set: { lat: 28.55563, lng: 77.09519 } });
  });

  it('accepts a text/csv body, requires content and the manage task', async () => {
    const res = await superAdmin.post('/api/v1/airports/import').set('Content-Type', 'text/csv').send('iata,name,city,state,lat,lng\nNEW,Renamed,Newtown,Karnataka,1,2\n');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rows: 1, inserted: 0, updated: 1, rejected: 0 });
    expect((await AirportModel.findOne({ iata: 'NEW' }).lean())?.name).toBe('Renamed');
    expectError(await superAdmin.post('/api/v1/airports/import').set('Content-Type', 'text/csv').send('   '), 400, 'VALIDATION');
    expectError(await analyst.post('/api/v1/airports/import').set('Content-Type', 'text/csv').send(csv), 403, 'FORBIDDEN');
  });
});
