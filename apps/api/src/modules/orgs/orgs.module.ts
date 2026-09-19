import type { Request } from 'express';
import { defineModule } from '../../kernel/router.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import { principalOf } from '../../kernel/auth.js';
import { assertPlatformCapability } from './orgs.access.js';
import {
  CreateOrganization,
  CreateUser,
  DeactivateMember,
  InviteMember,
  LinkIdentity,
  MemberListQuery,
  MembershipIdParam,
  OrgIdParam,
  OrgListQuery,
  PatchMember,
  PatchOrganization,
  PatchOwnOrganization,
  PatchUser,
  RegisterOrganization,
  TransitionOrganization,
  UserIdParam,
  UserListQuery,
} from './orgs.contracts.js';
import {
  addMember,
  deactivateMember,
  getMember,
  listMembers,
  patchMember,
  refreshExpiredMemberships,
} from './orgs.members.js';
import {
  createOrganization,
  getOrganization,
  listOrganizations,
  myMemberships,
  patchOrganization,
  patchOwnOrganization,
  readOwnOrganization,
  registerOrganization,
  transitionOrganization,
} from './orgs.registry.js';
import { createUser, getUser, linkIdentity, listUsers, patchUser, refreshUserAccess } from './orgs.users.js';

export const ORGS_READ = 'orgs:read';
export const ORGS_WRITE = 'orgs:write';
export const ORGS_MEMBERS_READ = 'orgs.members:read';
export const ORGS_MEMBERS_WRITE = 'orgs.members:write';
export const ORGS_REGISTRY_READ = 'orgs.registry:read';
export const ORGS_REGISTRY_WRITE = 'orgs.registry:write';

/**
 * The capability a platform route declares is checked here rather than left to
 * the router. The router enters system scope before its own guard runs, and in
 * system scope every capability answers true, so a platform route that trusted
 * the declaration would be open to any authenticated account. This also insists
 * the capability was granted inside an organisation that administers others.
 */
async function platformActor(req: Request, capability: string): Promise<string> {
  const principal = await assertPlatformCapability(principalOf(req), capability);
  return principal.userId;
}

export const orgsModule = defineModule({
  name: 'orgs',
  basePath: '/v1/orgs',
  capabilities: [
    ORGS_READ,
    ORGS_WRITE,
    ORGS_MEMBERS_READ,
    ORGS_MEMBERS_WRITE,
    ORGS_REGISTRY_READ,
    ORGS_REGISTRY_WRITE,
  ],
  routes: [
    {
      method: 'post',
      path: '/registrations',
      summary: 'Apply to join CSQ as an operator or an assessor firm',
      status: 201,
      policy: {
        requiredCapability: null,
        tenancy: 'PUBLIC',
        // Stated rather than left blank so the route audit can prove this is
        // deliberate. The applicant has no account yet, so there is nobody to
        // authenticate, and the handler writes an application record and
        // nothing anyone could sign in with.
        openReason: 'Self-registration: the applicant has no identity yet and the route creates no credential.',
      },
      handler: (req) => registerOrganization(parseBody(RegisterOrganization, req)),
    },
    {
      method: 'get',
      path: '/memberships/mine',
      summary: 'Organisations the caller belongs to, for the organisation switcher',
      policy: {
        requiredCapability: null,
        tenancy: 'SELF',
        openReason: 'Reports only the memberships the caller already holds, and is what chooses an organisation',
      },
      handler: () => myMemberships(requirePrincipal()),
    },
    {
      method: 'get',
      path: '/me',
      summary: 'The organisation the caller is acting in',
      policy: { requiredCapability: ORGS_READ, tenancy: 'ORG' },
      handler: () => readOwnOrganization(),
    },
    {
      method: 'patch',
      path: '/me',
      summary: 'Update the calling organisation own details',
      policy: { requiredCapability: ORGS_WRITE, tenancy: 'ORG' },
      handler: (req) => patchOwnOrganization(parseBody(PatchOwnOrganization, req)),
    },
    {
      method: 'get',
      path: '/me/members',
      summary: 'People in the calling organisation',
      policy: { requiredCapability: ORGS_MEMBERS_READ, tenancy: 'ORG' },
      handler: (req) => listMembers(parseQuery(MemberListQuery, req)),
    },
    {
      method: 'post',
      path: '/me/members',
      summary: 'Invite somebody into the calling organisation',
      status: 201,
      policy: { requiredCapability: ORGS_MEMBERS_WRITE, tenancy: 'ORG' },
      handler: (req) => addMember(parseBody(InviteMember, req), requirePrincipal().userId),
    },
    {
      method: 'get',
      path: '/me/members/:membershipId',
      summary: 'One membership in the calling organisation',
      policy: { requiredCapability: ORGS_MEMBERS_READ, tenancy: 'ORG' },
      handler: (req) => getMember(parseParams(MembershipIdParam, req).membershipId),
    },
    {
      method: 'patch',
      path: '/me/members/:membershipId',
      summary: 'Change what a member may do, how wide, and for how long',
      policy: { requiredCapability: ORGS_MEMBERS_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        patchMember(parseParams(MembershipIdParam, req).membershipId, parseBody(PatchMember, req)),
    },
    {
      method: 'delete',
      path: '/me/members/:membershipId',
      summary: 'Deactivate a membership, keeping the history it produced',
      policy: { requiredCapability: ORGS_MEMBERS_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        deactivateMember(
          parseParams(MembershipIdParam, req).membershipId,
          parseBody(DeactivateMember, req).reason ?? null,
        ),
    },
    {
      method: 'get',
      path: '/users',
      summary: 'The people directory, across organisations',
      policy: { requiredCapability: ORGS_REGISTRY_READ, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_READ);
        return listUsers(parseQuery(UserListQuery, req));
      },
    },
    {
      method: 'post',
      path: '/users',
      summary: 'Create a person before any organisation invites them',
      status: 201,
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return createUser(parseBody(CreateUser, req));
      },
    },
    {
      method: 'get',
      path: '/users/:userId',
      summary: 'One person and every membership they hold',
      policy: { requiredCapability: ORGS_REGISTRY_READ, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_READ);
        return getUser(parseParams(UserIdParam, req).userId);
      },
    },
    {
      method: 'patch',
      path: '/users/:userId',
      summary: 'Edit a person, including suspending the account',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return patchUser(parseParams(UserIdParam, req).userId, parseBody(PatchUser, req));
      },
    },
    {
      method: 'post',
      path: '/users/:userId/identity',
      summary: 'Link the Keycloak account that lets this person sign in',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return linkIdentity(parseParams(UserIdParam, req).userId, parseBody(LinkIdentity, req).kcUserId);
      },
    },
    {
      method: 'post',
      path: '/users/:userId/access-refresh',
      summary: 'Recompute one person access from the memberships on record',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return refreshUserAccess(parseParams(UserIdParam, req).userId);
      },
    },
    {
      method: 'post',
      path: '/maintenance/validity-sweep',
      summary: 'Apply validity windows that have opened or closed since the last sweep',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return refreshExpiredMemberships();
      },
    },
    {
      method: 'get',
      path: '/',
      summary: 'The organisation registry',
      policy: { requiredCapability: ORGS_REGISTRY_READ, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_READ);
        return listOrganizations(parseQuery(OrgListQuery, req));
      },
    },
    {
      method: 'post',
      path: '/',
      summary: 'Create an organisation without an application',
      status: 201,
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return createOrganization(parseBody(CreateOrganization, req));
      },
    },
    {
      method: 'get',
      path: '/:orgId',
      summary: 'One organisation from the registry',
      policy: { requiredCapability: ORGS_REGISTRY_READ, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_READ);
        return getOrganization(parseParams(OrgIdParam, req).orgId);
      },
    },
    {
      method: 'patch',
      path: '/:orgId',
      summary: 'Edit any organisation, including how its sampling is approved',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_WRITE);
        return patchOrganization(parseParams(OrgIdParam, req).orgId, parseBody(PatchOrganization, req));
      },
    },
    {
      method: 'post',
      path: '/:orgId/transition',
      summary: 'Submit, approve, reject, suspend or reinstate an organisation',
      policy: { requiredCapability: ORGS_REGISTRY_WRITE, tenancy: 'PLATFORM' },
      handler: async (req) => {
        const actorId = await platformActor(req, ORGS_REGISTRY_WRITE);
        return transitionOrganization(
          parseParams(OrgIdParam, req).orgId,
          parseBody(TransitionOrganization, req),
          actorId,
        );
      },
    },
    {
      method: 'get',
      path: '/:orgId/members',
      summary: 'People in any organisation, for platform support',
      policy: { requiredCapability: ORGS_REGISTRY_READ, tenancy: 'PLATFORM' },
      handler: async (req) => {
        await platformActor(req, ORGS_REGISTRY_READ);
        return listMembers(parseQuery(MemberListQuery, req), parseParams(OrgIdParam, req).orgId);
      },
    },
  ],
});
