// The thirteen illustrative operators (ACO organisations) at ten Phase-I
// airports, created through the organisations service so each gets its
// INVITED admin, its membership, its invitation e-mail and its audit row.
// Names are fictional; the quality profile drives the generated ratings.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import type { AirportDoc } from '../../modules/airports/airports.model.js';
import { findAirportByIata } from '../../modules/airports/airports.service.js';
import type { UserDoc } from '../../modules/identity/users.model.js';
import { findOrCreateInvitedUser } from '../../modules/identity/users.service.js';
import { getMarketShare, putMarketShare } from '../../modules/organisations/market-share.service.js';
import { createOperator } from '../../modules/organisations/operators.service.js';
import { OrganisationModel, type OrganisationDoc } from '../../modules/organisations/organisations.model.js';
import { findOrganisationByCode, findOrganisationById } from '../../modules/organisations/organisations.service.js';

import { demoKey, findDemoId, tagDemo } from './runtime.js';

export type HeadCode = 'INFRA' | 'SEC' | 'PROC' | 'TRADE';

export interface OperatorSpec {
  code: string;
  iata: string;
  name: string;
  city: string;
  state: string;
  pincode: string;
  /** Metros run domestic and international cargo; the others domestic only. */
  international: boolean;
  /** Current market share at the airport; the shares of one airport total 100. */
  sharePct: number;
  /** Size of the FF / CB directory. */
  customers: number;
  /** 0 (poor) … 1 (excellent): the centre of the operator's rating distribution. */
  quality: number;
  /** Per-head shifts, so operators differ in profile and not only in level. */
  bias: Partial<Record<HeadCode, number>>;
  admin: { name: string; email: string; phone: string };
}

const op = (
  code: string,
  iata: string,
  name: string,
  place: [city: string, state: string, pincode: string],
  international: boolean,
  sharePct: number,
  customers: number,
  quality: number,
  bias: Partial<Record<HeadCode, number>>,
  admin: [name: string, email: string],
): OperatorSpec => ({
  code,
  iata,
  name,
  city: place[0],
  state: place[1],
  pincode: place[2],
  international,
  sharePct,
  customers,
  quality,
  bias,
  admin: { name: admin[0], email: admin[1], phone: '+91 98100 00000' },
});

/** Illustrative figures only: shares, directory sizes and quality are invented for the demo. */
export const OPERATORS: readonly OperatorSpec[] = [
  op('DEL-CTS', 'DEL', 'Delhi Cargo Terminal Services', ['New Delhi', 'Delhi', '110037'], true, 58, 110, 0.86, { PROC: 0.04 }, ['Asha Rao', 'asha.rao@delcts.example.in']),
  op('DEL-NCH', 'DEL', 'Northern Cargo Hub', ['New Delhi', 'Delhi', '110037'], true, 42, 84, 0.7, { INFRA: -0.06 }, ['Vikram Mehta', 'vikram.mehta@northerncargohub.example.in']),
  op('BOM-MACH', 'BOM', 'Mumbai Air Cargo Handling', ['Mumbai', 'Maharashtra', '400099'], true, 55, 96, 0.66, { INFRA: -0.1, TRADE: 0.05 }, ['Priya Nair', 'priya.nair@mumbaiaircargo.example.in']),
  op('BOM-WCL', 'BOM', 'Western Cargo Logistics Terminal', ['Mumbai', 'Maharashtra', '400099'], true, 45, 72, 0.6, { SEC: -0.05 }, ['Rohan Desai', 'rohan.desai@westerncargo.example.in']),
  op('BLR-GCT', 'BLR', 'Garden City Cargo Terminal', ['Bengaluru', 'Karnataka', '560300'], true, 62, 104, 0.9, { INFRA: 0.03 }, ['Kavitha Reddy', 'kavitha.reddy@gardencitycargo.example.in']),
  op('BLR-SCS', 'BLR', 'Southern Cargo Services Bengaluru', ['Bengaluru', 'Karnataka', '560300'], true, 38, 68, 0.7, { PROC: -0.08 }, ['Arjun Iyer', 'arjun.iyer@southerncargo.example.in']),
  op('HYD-DCT', 'HYD', 'Deccan Cargo Terminal', ['Hyderabad', 'Telangana', '500409'], true, 100, 78, 0.76, { TRADE: -0.04 }, ['Sunita Menon', 'sunita.menon@deccancargo.example.in']),
  op('MAA-CCG', 'MAA', 'Chennai Cargo Gateway', ['Chennai', 'Tamil Nadu', '600027'], true, 100, 66, 0.68, { SEC: 0.04, INFRA: -0.08 }, ['Rajesh Kulkarni', 'rajesh.kulkarni@chennaicargogateway.example.in']),
  op('CCU-ECT', 'CCU', 'Eastern Cargo Terminal Kolkata', ['Kolkata', 'West Bengal', '700052'], false, 100, 40, 0.52, { SEC: -0.1 }, ['Deepa Banerjee', 'deepa.banerjee@easterncargo.example.in']),
  op('COK-KCH', 'COK', 'Kerala Cargo Handling', ['Kochi', 'Kerala', '683111'], false, 100, 38, 0.64, { INFRA: 0.05 }, ['Thomas Varghese', 'thomas.varghese@keralacargo.example.in']),
  op('AMD-GCS', 'AMD', 'Gujarat Cargo Services', ['Ahmedabad', 'Gujarat', '382475'], false, 100, 38, 0.58, { PROC: -0.06 }, ['Hetal Shah', 'hetal.shah@gujaratcargo.example.in']),
  op('GOI-KCT', 'GOI', 'Konkan Cargo Terminal', ['Vasco da Gama', 'Goa', '403801'], false, 100, 36, 0.5, { TRADE: -0.08 }, ['Nikhil Naik', 'nikhil.naik@konkancargo.example.in']),
  op('PNQ-PCL', 'PNQ', 'Pune Cargo Logistics', ['Pune', 'Maharashtra', '411032'], false, 100, 37, 0.56, { INFRA: -0.04 }, ['Meera Joshi', 'meera.joshi@punecargo.example.in']),
];

export interface DemoOperator {
  spec: OperatorSpec;
  org: OrganisationDoc;
  airport: AirportDoc;
  admin: UserDoc;
  created: boolean;
}

function slug(spec: OperatorSpec): string {
  return spec.code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function requireAirport(iata: string): Promise<AirportDoc> {
  const airport = await findAirportByIata(iata);
  if (!airport) throw new Error(`Airport ${iata} is not seeded; run npm run seed first`);
  return airport;
}

async function ensureOperator(ctx: RequestContext, spec: OperatorSpec): Promise<DemoOperator> {
  const key = demoKey('operator', spec.code);
  const airport = await requireAirport(spec.iata);
  let orgId = await findDemoId(OrganisationModel, key);
  let created = false;
  if (orgId === null) {
    // An interrupted earlier run may have created the organisation before tagging it: adopt it.
    const untagged = await findOrganisationByCode(spec.code);
    if (untagged) {
      orgId = idString(untagged._id);
      await tagDemo(OrganisationModel, orgId, key);
    }
  }
  if (orgId === null) {
    const dto = await createOperator(ctx, {
      code: spec.code,
      name: spec.name,
      legalName: `${spec.name} Private Limited`,
      airportId: idString(airport._id),
      operations: { domestic: true, international: spec.international },
      address: { line1: `Cargo Terminal, ${airport.name}`, line2: null, city: spec.city, state: spec.state, pincode: spec.pincode },
      contact: { name: 'Operations Desk', email: `ops@${slug(spec)}.example.in`, phone: '+91 11 2565 0000' },
      admin: spec.admin,
      marketSharePct: spec.sharePct,
    });
    orgId = dto.id;
    await tagDemo(OrganisationModel, orgId, key);
    created = true;
  }
  const org = await findOrganisationById(orgId);
  if (!org) throw new Error(`Operator ${spec.code} vanished`);
  // The admin already exists (createOperator made it); this lookup never creates.
  const { user: admin } = await findOrCreateInvitedUser(spec.admin);
  return { spec, org, airport, admin, created };
}

export async function ensureOperators(ctx: RequestContext): Promise<DemoOperator[]> {
  const operators: DemoOperator[] = [];
  for (const spec of OPERATORS) operators.push(await ensureOperator(ctx, spec));
  return operators;
}

/** The current (cycle-less) shares per airport, written as a whole set so the total-100 rule is checked; unchanged sets are left alone. */
export async function ensureMarketShares(ctx: RequestContext, operators: readonly DemoOperator[]): Promise<number> {
  const byAirport = new Map<string, DemoOperator[]>();
  for (const operator of operators) {
    const airportId = idString(operator.airport._id);
    byAirport.set(airportId, [...(byAirport.get(airportId) ?? []), operator]);
  }
  let written = 0;
  for (const [airportId, members] of byAirport) {
    const wanted = members.map((member) => ({ acoId: idString(member.org._id), sharePct: member.spec.sharePct }));
    const current = await getMarketShare(ctx, airportId, null);
    const same =
      current.entries.length === wanted.length &&
      wanted.every((entry) => current.entries.some((row) => row.acoId === entry.acoId && row.sharePct === entry.sharePct));
    if (same) continue;
    await putMarketShare(ctx, airportId, { entries: wanted, note: 'Illustrative demo shares' });
    written += 1;
  }
  return written;
}
