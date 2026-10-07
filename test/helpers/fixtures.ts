import type { Response } from 'supertest';
import { expect } from 'vitest';

import { idString } from '../../src/core/ids.js';
import { findAirportByIata } from '../../src/modules/airports/airports.service.js';
import { RoleTaskModel } from '../../src/modules/identity/role-tasks.model.js';
import { findRoleByCode } from '../../src/modules/identity/roles.service.js';
import { TaskModel } from '../../src/modules/identity/tasks.model.js';
import type { OrganisationDoc } from '../../src/modules/organisations/organisations.model.js';
import { createOrganisation, findOrganisationByCode } from '../../src/modules/organisations/organisations.service.js';
import { bumpRbacVersion } from '../../src/modules/settings/settings.service.js';

export async function airportIdByIata(iata: string): Promise<string> {
  const airport = await findAirportByIata(iata);
  if (!airport) throw new Error(`Airport ${iata} not seeded`);
  return idString(airport._id);
}

export interface TestOrgOptions {
  code: string;
  name?: string;
  airportIata?: string;
  status?: OrganisationDoc['status'];
}

/** An ACO organisation straight in the database (no admin user, no notification). */
export async function createTestOperator(options: TestOrgOptions): Promise<OrganisationDoc> {
  const existing = await findOrganisationByCode(options.code);
  if (existing) return existing;
  return createOrganisation({
    type: 'ACO',
    code: options.code,
    name: options.name ?? `${options.code} Cargo`,
    airportId: await airportIdByIata(options.airportIata ?? 'DEL'),
    operations: { domestic: true, international: true },
    contact: { name: 'Ops Desk', email: `ops@${options.code.toLowerCase()}.test`, phone: '+91 99999 00000' },
    status: options.status ?? 'ACTIVE',
  });
}

export async function createAirportOrg(options: TestOrgOptions): Promise<OrganisationDoc> {
  const existing = await findOrganisationByCode(options.code);
  if (existing) return existing;
  return createOrganisation({
    type: 'AIRPORT',
    code: options.code,
    name: options.name ?? `${options.code} Airport Org`,
    airportId: await airportIdByIata(options.airportIata ?? 'DEL'),
    status: options.status ?? 'ACTIVE',
  });
}

/** Grants tasks to a role directly (test shortcut around PUT /roles/matrix); bumps rbacVersion. */
export async function grantTasks(roleCode: string, taskCodes: string[]): Promise<void> {
  const role = await findRoleByCode(roleCode);
  if (!role) throw new Error(`Role ${roleCode} not seeded`);
  const tasks = await TaskModel.find({ code: { $in: taskCodes } }).lean();
  if (tasks.length !== taskCodes.length) throw new Error(`Unknown task among ${taskCodes.join(', ')}`);
  await RoleTaskModel.bulkWrite(
    tasks.map((task) => ({
      updateOne: {
        filter: { roleId: role._id, taskId: task._id },
        update: { $set: { enabled: true }, $setOnInsert: { roleId: role._id, taskId: task._id } },
        upsert: true,
      },
    })),
  );
  await bumpRbacVersion();
}

export async function revokeTasks(roleCode: string, taskCodes: string[]): Promise<void> {
  const role = await findRoleByCode(roleCode);
  if (!role) throw new Error(`Role ${roleCode} not seeded`);
  const tasks = await TaskModel.find({ code: { $in: taskCodes } }).lean();
  await RoleTaskModel.updateMany({ roleId: role._id, taskId: { $in: tasks.map((task) => task._id) } }, { $set: { enabled: false } });
  await bumpRbacVersion();
}

/** A valid POST /operators body. */
export function operatorPayload(airportId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'DEL-CARGO',
    name: 'Delhi Cargo Terminal',
    legalName: 'Delhi Cargo Terminal Pvt Ltd',
    airportId,
    operations: { domestic: true, international: true },
    address: { line1: 'Cargo Terminal 2', line2: null, city: 'New Delhi', state: 'Delhi', pincode: '110037' },
    contact: { name: 'Ops Desk', email: 'ops@delcargo.test', phone: '+91 11 2565 0000' },
    admin: { name: 'Asha Rao', email: 'asha.rao@delcargo.test', phone: '+91 98100 00000' },
    marketSharePct: 60,
    ...overrides,
  };
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

/** Asserts the error envelope and returns it. */
export function expectError(res: Response, status: number, code: string): ErrorBody['error'] {
  expect(res.status, `expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`).toBe(status);
  const body = res.body as ErrorBody;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.requestId).toBe('string');
  return body.error;
}
