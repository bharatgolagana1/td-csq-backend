import type { MembershipDoc, OrgUserDoc, OrganizationDoc } from './orgs.models.js';
import { isLinked } from './orgs.models.js';
import type { MemberView, OrganizationView, PageOf, UserView } from './orgs.contracts.js';

/** Wire shapes in one place, so two endpoints cannot disagree about a field name. */

export function toOrganizationView(doc: OrganizationDoc): OrganizationView {
  return {
    id: doc._id,
    type: doc.type,
    state: doc.state,
    legalName: doc.legalName,
    displayName: doc.displayName,
    code: doc.code,
    airportId: doc.airportId,
    address: { ...doc.address },
    registrationIds: { ...doc.registrationIds },
    formScope: doc.formScope,
    samplingApprovalMode: doc.samplingApprovalMode,
    primaryContact: doc.primaryContact ? { ...doc.primaryContact } : null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
    approvedAt: doc.approvedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toUserView(doc: OrgUserDoc): UserView {
  return {
    id: doc._id,
    kind: doc.kind,
    email: doc.email,
    givenName: doc.givenName,
    familyName: doc.familyName,
    displayName: doc.displayName,
    phoneE164: doc.phoneE164,
    whatsappOptIn: doc.whatsappOptIn,
    status: doc.status,
    // the placeholder subject an unlinked account carries is an implementation
    // detail of the kernel's unique index and never leaves the server
    kcUserId: isLinked(doc.subject) ? doc.subject : null,
    membershipsVersion: doc.membershipsVersion,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toMemberView(
  membership: MembershipDoc & { orgId: string },
  user: OrgUserDoc,
  capabilities: readonly string[],
): MemberView {
  return {
    membershipId: membership._id,
    orgId: membership.orgId,
    user: toUserView(user),
    roleClasses: [...membership.roleClasses],
    capabilities: [...capabilities],
    scopeMode: membership.scopeMode,
    scopeIds: [...membership.scopeIds],
    validFrom: membership.validFrom.toISOString(),
    validUntil: membership.validUntil?.toISOString() ?? null,
    isActive: membership.isActive,
    effective: membership.projectedActive,
    createdAt: membership.createdAt.toISOString(),
  };
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * An anchored prefix match against an already folded column, with every regex
 * metacharacter escaped. Anchored so it can use the index, escaped so a search
 * box cannot ship a catastrophic backtracking pattern to the database.
 */
export function anchoredPrefix(term: string, fold: 'lower' | 'upper'): RegExp {
  const folded = fold === 'lower' ? term.trim().toLowerCase() : term.trim().toUpperCase();
  return new RegExp(`^${folded.replace(REGEX_META, '\\$&')}`);
}

export function pageOf<T>(
  items: readonly T[],
  total: number,
  query: { limit: number; offset: number },
): PageOf<T> {
  return {
    items,
    page: {
      limit: query.limit,
      offset: query.offset,
      total,
      hasMore: query.offset + items.length < total,
    },
  };
}
