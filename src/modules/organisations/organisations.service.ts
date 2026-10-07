// Organisation storage operations shared by identity (membership targets),
// operators (ACO orchestration) and the seed. Deliberately free of imports
// from identity so the dependency graph stays acyclic.
import type { ClientSession, Types } from 'mongoose';

import { idString, toId } from '../../core/ids.js';
import type { RoleScope } from '../identity/roles.model.js';

import {
  OrganisationModel,
  type Address,
  type Contact,
  type CreatedVia,
  type Operations,
  type OrganisationDoc,
  type OrgStatus,
  type OrgType,
} from './organisations.model.js';

/** Which role scope a membership in an organisation of this type must carry. */
export const ROLE_SCOPE_FOR_ORG_TYPE: Record<OrgType, RoleScope> = {
  ACFI: 'PLATFORM',
  ACO: 'ACO',
  AIRPORT: 'AIRPORT',
};

export const ACFI_ORG = { code: 'ACFI', name: 'Air Cargo Forum India' } as const;

export interface OrganisationView {
  id: string;
  type: OrgType;
  code: string;
  name: string;
  airportId: string | null;
  legalName: string | null;
  address: Address | null;
  contact: Contact | null;
  operations: Operations;
  status: OrgStatus;
  createdVia: CreatedVia;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toOrganisationView(doc: OrganisationDoc): OrganisationView {
  return {
    id: idString(doc._id),
    type: doc.type,
    code: doc.code,
    name: doc.name,
    airportId: doc.airportId ? idString(doc.airportId) : null,
    legalName: doc.legalName,
    address: doc.address ? { ...doc.address } : null,
    contact: doc.contact ? { ...doc.contact } : null,
    operations: { domestic: doc.operations.domestic, international: doc.operations.international },
    status: doc.status,
    createdVia: doc.createdVia,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    approvedBy: doc.approvedBy ? idString(doc.approvedBy) : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function findOrganisationById(id: string | Types.ObjectId): Promise<OrganisationDoc | null> {
  return OrganisationModel.findById(toId(idString(id))).lean<OrganisationDoc>();
}

export async function findOrganisationsByIds(ids: Iterable<string | Types.ObjectId>): Promise<Map<string, OrganisationDoc>> {
  const unique = [...new Set([...ids].map(idString))];
  if (unique.length === 0) return new Map();
  const docs = await OrganisationModel.find({ _id: { $in: unique.map((id) => toId(id)) } }).lean<OrganisationDoc[]>();
  return new Map(docs.map((doc) => [idString(doc._id), doc]));
}

export async function findOrganisationByCode(code: string): Promise<OrganisationDoc | null> {
  return OrganisationModel.findOne({ code: code.trim().toUpperCase() }).lean<OrganisationDoc>();
}

export interface CreateOrganisationInput {
  type: OrgType;
  code: string;
  name: string;
  airportId: string | null;
  legalName?: string | null;
  address?: Address | null;
  contact?: Contact | null;
  operations?: Operations;
  status?: OrgStatus;
  createdVia?: CreatedVia;
  approvedBy?: string | null;
}

export async function createOrganisation(input: CreateOrganisationInput, session?: ClientSession): Promise<OrganisationDoc> {
  const status = input.status ?? 'ACTIVE';
  const [created] = await OrganisationModel.create(
    [
      {
        type: input.type,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        airportId: input.airportId ? toId(input.airportId, 'airportId') : null,
        legalName: input.legalName ?? null,
        address: input.address ?? null,
        contact: input.contact ?? null,
        operations: input.operations ?? { domestic: false, international: false },
        status,
        createdVia: input.createdVia ?? 'ADMIN',
        approvedAt: status === 'ACTIVE' ? new Date() : null,
        approvedBy: input.approvedBy ? toId(input.approvedBy) : null,
      },
    ],
    session ? { session } : {},
  );
  if (!created) throw new Error('Organisation insert returned nothing');
  return created.toObject();
}

/** The platform organisation; the seed creates it and every SUPER_ADMIN belongs to it. */
export async function ensureAcfiOrganisation(): Promise<OrganisationDoc> {
  const existing = await findOrganisationByCode(ACFI_ORG.code);
  if (existing) return existing;
  return createOrganisation({ type: 'ACFI', code: ACFI_ORG.code, name: ACFI_ORG.name, airportId: null });
}
