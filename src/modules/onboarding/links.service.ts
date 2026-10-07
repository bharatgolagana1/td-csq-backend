import type { FilterQuery } from 'mongoose';

import { assertScope } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { findAirportById, findAirportsByIds, requireAirport } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';
import type { UserDoc } from '../identity/users.model.js';
import { findUserById } from '../identity/users.service.js';
import { generateToken, hashToken, isWellFormedToken } from '../invitations/domain/token.js';

import { OnboardingLinkModel, type OnboardingLinkDoc } from './onboarding-links.model.js';
import type { CreatedLinkDto, CreateLinkInput, LinkListQuery, LinkStatus, OnboardingLinkDto, PublicLinkDto } from './onboarding.schemas.js';
import { registrationFormUrl } from './onboarding.urls.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function linkStatus(doc: Pick<OnboardingLinkDoc, 'usedAt' | 'expiresAt'>, now = new Date()): LinkStatus {
  if (doc.usedAt) return 'USED';
  return doc.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'OPEN';
}

async function toLinkDtos(docs: OnboardingLinkDoc[]): Promise<OnboardingLinkDto[]> {
  const creatorIds = [...new Set(docs.map((doc) => idString(doc.createdBy)))];
  const [airports, creators] = await Promise.all([
    findAirportsByIds(docs.map((doc) => doc.airportId)),
    Promise.all(creatorIds.map(async (id) => [id, await findUserById(id)] as const)),
  ]);
  const creatorById = new Map<string, UserDoc | null>(creators);
  const now = new Date();
  return docs.map((doc) => {
    const airport = airports.get(idString(doc.airportId));
    const creator = creatorById.get(idString(doc.createdBy)) ?? null;
    return {
      id: idString(doc._id),
      orgType: doc.orgType,
      airport: airport ? { id: idString(airport._id), iata: airport.iata, name: airport.name } : null,
      createdBy: creator ? { id: idString(creator._id), name: creator.name, email: creator.email } : null,
      expiresAt: doc.expiresAt.toISOString(),
      usedAt: doc.usedAt?.toISOString() ?? null,
      registrationId: doc.registrationId ? idString(doc.registrationId) : null,
      note: doc.note,
      status: linkStatus(doc, now),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

/**
 * POST /onboarding/links: mints a 32-byte token, stores its hash and returns
 * the registration URL — the only time the raw token leaves the server.
 */
export async function createLink(ctx: RequestContext, input: CreateLinkInput): Promise<CreatedLinkDto> {
  assertScope(ctx, 'PLATFORM');
  await requireAirport(input.airportId);
  const token = generateToken();
  const created = (
    await OnboardingLinkModel.create({
      tokenHash: hashToken(token),
      orgType: input.orgType,
      airportId: toId(input.airportId, 'airportId'),
      createdBy: toId(ctx.user.id),
      expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
      note: input.note ?? null,
    })
  ).toObject();
  const dto = (await toLinkDtos([created]))[0] as OnboardingLinkDto;
  await audit(ctx, { action: 'onboarding.link.created', entity: 'onboarding_link', entityId: dto.id, after: dto });
  return { ...dto, url: registrationFormUrl(token) };
}

const SORTABLE = ['createdAt', 'expiresAt', 'orgType'] as const;

function statusFilter(status: LinkStatus | undefined, now: Date): FilterQuery<OnboardingLinkDoc> {
  if (status === 'USED') return { usedAt: { $ne: null } };
  if (status === 'EXPIRED') return { usedAt: null, expiresAt: { $lte: now } };
  if (status === 'OPEN') return { usedAt: null, expiresAt: { $gt: now } };
  return {};
}

export async function listLinks(ctx: RequestContext, query: LinkListQuery): Promise<Page<OnboardingLinkDto>> {
  assertScope(ctx, 'PLATFORM');
  const requested: FilterQuery<OnboardingLinkDoc> = {};
  if (query.orgType) requested.orgType = query.orgType;
  if (query.airportId) requested.airportId = toId(query.airportId);
  const filter = and<OnboardingLinkDoc>(statusFilter(query.status, new Date()), searchFilter<OnboardingLinkDoc>(query.q, ['note']), requested);
  const sort = parseSort(query.sort, SORTABLE, '-createdAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    OnboardingLinkModel.find(filter).sort(sort).skip(skip).limit(limit).lean<OnboardingLinkDoc[]>(),
    OnboardingLinkModel.countDocuments(filter),
  ]);
  return pageOf(await toLinkDtos(docs), total, query);
}

/** DELETE /onboarding/links/:id revokes an open or expired link; a used link is history and stays. */
export async function deleteLink(ctx: RequestContext, id: string): Promise<void> {
  assertScope(ctx, 'PLATFORM');
  const doc = await OnboardingLinkModel.findById(toId(id)).lean<OnboardingLinkDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Onboarding link not found');
  if (doc.usedAt) throw new AppError('PRECONDITION_FAILED', 'This link has already been used and cannot be revoked');
  await OnboardingLinkModel.deleteOne({ _id: doc._id });
  await audit(ctx, {
    action: 'onboarding.link.deleted',
    entity: 'onboarding_link',
    entityId: id,
    before: { orgType: doc.orgType, airportId: idString(doc.airportId), expiresAt: doc.expiresAt.toISOString(), note: doc.note },
  });
}

/**
 * Resolves a raw token from the public URL. Unknown or malformed tokens are
 * 404 (nothing to probe); an unused link past `expiresAt` is 410. A used link
 * is returned as is — the caller decides between showing "already used" and
 * refusing a second submission.
 */
export async function findLinkByToken(token: string): Promise<OnboardingLinkDoc> {
  if (!isWellFormedToken(token)) throw new AppError('NOT_FOUND', 'Onboarding link not found');
  const doc = await OnboardingLinkModel.findOne({ tokenHash: hashToken(token) }).lean<OnboardingLinkDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Onboarding link not found');
  if (!doc.usedAt && doc.expiresAt.getTime() <= Date.now()) {
    throw new AppError('LINK_EXPIRED', 'This onboarding link has expired');
  }
  return doc;
}

/** GET /public/onboarding/:token — what the form page needs before it renders. */
export async function getPublicLink(token: string): Promise<PublicLinkDto> {
  const doc = await findLinkByToken(token);
  const airport = await findAirportById(doc.airportId);
  return {
    orgType: doc.orgType,
    airport: airport ? { id: idString(airport._id), iata: airport.iata, name: airport.name } : null,
    expiresAt: doc.expiresAt.toISOString(),
    used: doc.usedAt !== null,
  };
}
