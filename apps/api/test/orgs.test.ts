import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  requireCapability,
  runAsPrincipal,
  runSystem,
  type Principal,
} from '../src/kernel/requestContext.js';
import { checkModule } from '../src/kernel/router.js';
import { UserModel } from '../src/kernel/identity/models.js';
import { newId } from '../src/kernel/ids.js';
import {
  MembershipModel,
  OrgUserModel,
  OrganizationModel,
  RoleDefinitionModel,
} from '../src/modules/orgs/orgs.models.js';
import { orgsModule } from '../src/modules/orgs/orgs.module.js';
import { loadRoleCatalogue, seedRoleDefinitions } from '../src/modules/orgs/orgs.seed.js';
import {
  addMember,
  deactivateMember,
  getMember,
  listMembers,
  patchMember,
  refreshExpiredMemberships,
} from '../src/modules/orgs/orgs.members.js';
import {
  createOrganization,
  getOrganization,
  listOrganizations,
  myMemberships,
  registerOrganization,
  transitionOrganization,
} from '../src/modules/orgs/orgs.registry.js';
import { createUser, linkIdentity, listUsers, patchUser } from '../src/modules/orgs/orgs.users.js';
import { assertPlatformCapability } from '../src/modules/orgs/orgs.access.js';
import {
  InviteMember,
  MemberListQuery,
  OrgListQuery,
  RegisterOrganization,
  UserListQuery,
} from '../src/modules/orgs/orgs.contracts.js';
import { closeDatabase, openDatabase, silentLog } from './mongo.js';

/**
 * The suite drives the services rather than HTTP, because what is worth proving
 * here is what the database and the access projection do, and a token signing
 * harness in front of it would only add a second thing that can be wrong.
 * Route policy is proved separately, by the same boot check the router runs.
 */

function asSystem<T>(fn: () => T): T {
  return runSystem({ reason: 'orgs test suite platform work', log: silentLog }, fn);
}

function inOrg<T>(principal: Principal, orgId: string, fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal, orgId }, fn);
}

/** Builds the principal the kernel would build, straight out of the projection. */
async function principalFromProjection(userId: string): Promise<Principal> {
  const row = await UserModel.findOne({ _id: userId }).lean().exec();
  if (!row) throw new Error('no auth row for that user');
  return {
    userId: row._id,
    subject: row.subject,
    email: row.email,
    displayName: row.displayName,
    memberships: row.memberships.map((m) => ({
      orgId: m.orgId,
      roles: [...m.roles],
      capabilities: [...m.capabilities],
      active: m.active,
    })),
  };
}

function application(overrides: Record<string, unknown> = {}): RegisterOrganization {
  return RegisterOrganization.parse({
    legalName: 'Mumbai Air Cargo Terminal Services Private Limited',
    code: 'BOM-T2',
    type: 'ACO',
    formScope: 'INTERNATIONAL',
    address: { city: 'Mumbai', state: 'Maharashtra', country: 'IN', region: 'West' },
    primaryContact: {
      givenName: 'Asha',
      familyName: 'Rao',
      email: 'asha.rao@example.org',
      phoneE164: '+919812345678',
    },
    ...overrides,
  });
}

/** Registers, approves, and hands back the organisation with its first administrator. */
async function approvedOrganization(
  overrides: Record<string, unknown> = {},
): Promise<{ orgId: string; adminId: string; admin: Principal }> {
  const registered = await registerOrganization(application(overrides));
  await asSystem(() => transitionOrganization(registered.organizationId, { action: 'APPROVE' }, null));

  const contact = await OrgUserModel.findOne({ _id: { $exists: true } })
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  if (!contact) throw new Error('approval created no account');

  const membership = await asSystem(() =>
    MembershipModel.findOne({ orgId: registered.organizationId, isActive: true }).lean().exec(),
  );
  if (!membership) throw new Error('approval created no membership');

  return {
    orgId: registered.organizationId,
    adminId: membership.userId,
    admin: await principalFromProjection(membership.userId),
  };
}

function invitation(overrides: Record<string, unknown> = {}): InviteMember {
  return InviteMember.parse({
    email: 'vikram.iyer@example.org',
    givenName: 'Vikram',
    familyName: 'Iyer',
    kind: 'STAFF',
    roleClasses: ['ACO_VIEWER'],
    ...overrides,
  });
}

describe('orgs module', () => {
  beforeAll(async () => {
    await openDatabase();
    await Promise.all([
      OrganizationModel.syncIndexes(),
      OrgUserModel.syncIndexes(),
      MembershipModel.syncIndexes(),
      RoleDefinitionModel.syncIndexes(),
    ]);
    await seedRoleDefinitions(loadRoleCatalogue());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    for (const name of [
      OrganizationModel.collection.name,
      OrgUserModel.collection.name,
      MembershipModel.collection.name,
      UserModel.collection.name,
    ]) {
      await mongoose.connection.collection(name).deleteMany({});
    }
  });

  describe('route policy', () => {
    it('passes the same check the router runs at boot', () => {
      expect(() => checkModule(orgsModule)).not.toThrow();
    });

    it('declares every capability its routes require, and no route without a policy', () => {
      const declared = new Set(orgsModule.capabilities);
      for (const route of orgsModule.routes) {
        expect(route.policy).toBeDefined();
        if (route.policy.requiredCapability !== null) {
          expect(declared.has(route.policy.requiredCapability)).toBe(true);
        } else {
          expect(route.policy.tenancy === 'PUBLIC' || Boolean(route.policy.openReason)).toBe(true);
        }
      }
    });

    it('registers no method and path twice', () => {
      const keys = orgsModule.routes.map((r) => `${r.method} ${r.path}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('the role catalogue', () => {
    it('is seeded from the data file rather than from literals in a handler', async () => {
      const rows = await RoleDefinitionModel.find({}).lean().exec();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r._id)).toContain('ACO_ADMIN');
    });

    it('gives each organisation type at most one role class granted on approval', async () => {
      const rows = await RoleDefinitionModel.find({ grantedOnApproval: true }).lean().exec();
      const byType = new Map<string, number>();
      for (const row of rows) {
        for (const type of row.orgTypes) byType.set(type, (byType.get(type) ?? 0) + 1);
      }
      for (const count of byType.values()) expect(count).toBe(1);
    });
  });

  describe('self registration and approval', () => {
    it('records an application without creating anything anybody can sign in with', async () => {
      const registered = await registerOrganization(application());

      expect(registered.state).toBe('PENDING_APPROVAL');
      expect(await OrgUserModel.countDocuments({}).exec()).toBe(0);
      expect(await UserModel.countDocuments({}).exec()).toBe(0);
    });

    it('refuses a second application for the same code', async () => {
      await registerOrganization(application());
      await expect(registerOrganization(application())).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('insists an ACO says which form it is assessed on', () => {
      expect(() => application({ formScope: null })).toThrow(/international or the domestic form/);
    });

    it('approval provisions the primary contact and projects their capabilities', async () => {
      const { orgId, adminId } = await approvedOrganization();

      const org = await asSystem(() => getOrganization(orgId));
      expect(org.state).toBe('ACTIVE');
      expect(org.approvedAt).not.toBeNull();

      const authRow = await UserModel.findOne({ _id: adminId }).lean().exec();
      expect(authRow?.memberships).toHaveLength(1);
      expect(authRow?.memberships[0]?.orgId).toBe(orgId);
      expect(authRow?.memberships[0]?.active).toBe(true);
      expect(authRow?.memberships[0]?.roles).toEqual(['ACO_ADMIN']);
      expect(authRow?.memberships[0]?.capabilities).toContain('orgs.members:write');
    });

    it('refuses to approve an organisation with nobody to hand the keys to', async () => {
      const org = await asSystem(() =>
        createOrganization({
          legalName: 'Assessors Without A Contact LLP',
          displayName: null,
          code: 'NOCONTACT',
          airportId: null,
          address: { city: 'Delhi', state: 'Delhi', country: 'IN', region: 'North' },
          registrationIds: { cin: null, gstin: null, pan: null },
          formScope: null,
          type: 'ASSESSOR_FIRM',
          samplingApprovalMode: 'SUPER_ADMIN',
          primaryContact: null,
        }),
      );
      await asSystem(() => transitionOrganization(org.id, { action: 'SUBMIT' }, null));

      await expect(
        asSystem(() => transitionOrganization(org.id, { action: 'APPROVE' }, null)),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('refuses a transition the state machine does not allow', async () => {
      const registered = await registerOrganization(application());
      await asSystem(() => transitionOrganization(registered.organizationId, { action: 'APPROVE' }, null));

      await expect(
        asSystem(() => transitionOrganization(registered.organizationId, { action: 'APPROVE' }, null)),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('suspension', () => {
    it('takes access away from every member and gives it back on reinstatement', async () => {
      const { orgId, adminId } = await approvedOrganization();

      await asSystem(() =>
        transitionOrganization(orgId, { action: 'SUSPEND', reason: 'Payment overdue' }, null),
      );
      const suspended = await UserModel.findOne({ _id: adminId }).lean().exec();
      expect(suspended?.memberships[0]?.active).toBe(false);
      expect(suspended?.memberships[0]?.capabilities).toEqual([]);

      await asSystem(() => transitionOrganization(orgId, { action: 'REINSTATE' }, null));
      const reinstated = await UserModel.findOne({ _id: adminId }).lean().exec();
      expect(reinstated?.memberships[0]?.active).toBe(true);
      expect(reinstated?.memberships[0]?.capabilities).toContain('orgs.members:write');
    });
  });

  describe('members', () => {
    it('invites somebody, projects their access and refuses a second live membership', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();

      const member = await inOrg(admin, orgId, () => addMember(invitation(), adminId));
      expect(member.effective).toBe(true);
      expect(member.capabilities).toEqual(['orgs:read', 'settings:read']);

      const projected = await UserModel.findOne({ _id: member.user.id }).lean().exec();
      expect(projected?.memberships[0]?.active).toBe(true);

      await expect(inOrg(admin, orgId, () => addMember(invitation(), adminId))).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('refuses a role class that does not exist or does not belong to this type of organisation', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();

      await expect(
        inOrg(admin, orgId, () => addMember(invitation({ roleClasses: ['NOT_A_ROLE'] }), adminId)),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      await expect(
        inOrg(admin, orgId, () => addMember(invitation({ roleClasses: ['EXTERNAL_ASSESSOR'] }), adminId)),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('carries a set of role classes, deduplicated and sorted', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const member = await inOrg(admin, orgId, () =>
        addMember(invitation({ roleClasses: ['ACO_ASSESSOR', 'ACO_ADMIN', 'ACO_ASSESSOR'] }), adminId),
      );

      expect(member.roleClasses).toEqual(['ACO_ADMIN', 'ACO_ASSESSOR']);
      expect(member.capabilities).toContain('orgs.members:write');
      expect(member.capabilities).toContain('orgs:read');
    });

    it('refuses to leave an organisation with nobody who can manage members', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const first = await inOrg(admin, orgId, () => listMembers(MemberListQuery.parse({})));
      const adminMembership = first.items[0];
      if (!adminMembership) throw new Error('no administrator on file');

      await expect(
        inOrg(admin, orgId, () => deactivateMember(adminMembership.membershipId, null)),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      await inOrg(admin, orgId, () => addMember(invitation({ roleClasses: ['ACO_ADMIN'] }), adminId));
      const removed = await inOrg(admin, orgId, () =>
        deactivateMember(adminMembership.membershipId, 'Left the company'),
      );
      expect(removed.isActive).toBe(false);
    });

    it('takes access away before the record says the membership ended', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const member = await inOrg(admin, orgId, () => addMember(invitation(), adminId));

      await inOrg(admin, orgId, () => deactivateMember(member.membershipId, 'Moved on'));

      const projected = await UserModel.findOne({ _id: member.user.id }).lean().exec();
      expect(projected?.memberships[0]?.active).toBe(false);
      expect(projected?.memberships[0]?.capabilities).toEqual([]);
    });

    it('frees the slot so somebody who left can be invited back', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const member = await inOrg(admin, orgId, () => addMember(invitation(), adminId));
      await inOrg(admin, orgId, () => deactivateMember(member.membershipId, null));

      const again = await inOrg(admin, orgId, () => addMember(invitation(), adminId));
      expect(again.membershipId).not.toBe(member.membershipId);
      expect(again.user.id).toBe(member.user.id);
    });

    it('answers a membership belonging to another organisation as if it did not exist', async () => {
      const first = await approvedOrganization();
      const second = await approvedOrganization({
        code: 'DEL-T1',
        legalName: 'Delhi Air Cargo Terminal Services Private Limited',
        primaryContact: { givenName: 'Meera', familyName: 'Nair', email: 'meera.nair@example.org' },
      });

      const mine = await inOrg(first.admin, first.orgId, () => listMembers(MemberListQuery.parse({})));
      const theirMembershipId = mine.items[0]?.membershipId;
      if (!theirMembershipId) throw new Error('no membership to probe with');

      await expect(
        inOrg(second.admin, second.orgId, () => getMember(theirMembershipId)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        inOrg(second.admin, second.orgId, () => patchMember(theirMembershipId, { roleClasses: ['ACO_VIEWER'] })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('pages, sorts and filters the member list', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const names = ['Bhavna', 'Chandra', 'Devi', 'Esha'];
      for (const [index, givenName] of names.entries()) {
        await inOrg(admin, orgId, () =>
          addMember(
            invitation({
              givenName,
              familyName: 'Kumar',
              email: `${givenName.toLowerCase()}@example.org`,
              roleClasses: index % 2 === 0 ? ['ACO_VIEWER'] : ['ACO_ASSESSOR'],
            }),
            adminId,
          ),
        );
      }

      const firstPage = await inOrg(admin, orgId, () =>
        listMembers(MemberListQuery.parse({ limit: '2', sort: 'displayName', order: 'asc' })),
      );
      expect(firstPage.page.total).toBe(5);
      expect(firstPage.page.hasMore).toBe(true);
      expect(firstPage.items.map((m) => m.user.givenName)).toEqual(['Asha', 'Bhavna']);

      const secondPage = await inOrg(admin, orgId, () =>
        listMembers(MemberListQuery.parse({ limit: '2', offset: '2', sort: 'displayName' })),
      );
      expect(secondPage.items.map((m) => m.user.givenName)).toEqual(['Chandra', 'Devi']);

      const viewers = await inOrg(admin, orgId, () =>
        listMembers(MemberListQuery.parse({ roleClass: 'ACO_VIEWER' })),
      );
      expect(viewers.page.total).toBe(2);

      const searched = await inOrg(admin, orgId, () => listMembers(MemberListQuery.parse({ q: 'dev' })));
      expect(searched.items.map((m) => m.user.givenName)).toEqual(['Devi']);
    });

    it('treats a search term as text rather than as a pattern', async () => {
      const { orgId, admin } = await approvedOrganization();
      const results = await inOrg(admin, orgId, () => listMembers(MemberListQuery.parse({ q: '.*' })));
      expect(results.page.total).toBe(0);
    });
  });

  describe('validity windows', () => {
    it('projects a membership that has not started yet as not effective', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

      const member = await inOrg(admin, orgId, () =>
        addMember(invitation({ validFrom: tomorrow }), adminId),
      );

      expect(member.effective).toBe(false);
      const projected = await UserModel.findOne({ _id: member.user.id }).lean().exec();
      expect(projected?.memberships[0]?.active).toBe(false);
    });

    it('withdraws access when a window closes, on the sweep rather than on a read', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const member = await inOrg(admin, orgId, () => addMember(invitation(), adminId));

      // the clock, not a request, is what ends a window: nothing writes to the
      // record when it closes, so the sweep is the only thing that can notice
      await asSystem(() =>
        MembershipModel.updateOne(
          { _id: member.membershipId, orgId },
          { $set: { validUntil: new Date(Date.now() - 1_000) } },
        ).exec(),
      );

      const swept = await asSystem(() => refreshExpiredMemberships());
      expect(swept.changed).toBe(1);

      const projected = await UserModel.findOne({ _id: member.user.id }).lean().exec();
      expect(projected?.memberships[0]?.active).toBe(false);

      const idempotent = await asSystem(() => refreshExpiredMemberships());
      expect(idempotent.changed).toBe(0);
    });

    it('refuses a window that ends before it starts', async () => {
      expect(() =>
        invitation({
          validFrom: new Date(Date.now() + 86_400_000).toISOString(),
          validUntil: new Date().toISOString(),
        }),
      ).toThrow(/end after it starts/);
    });
  });

  describe('scope', () => {
    it('refuses an organisation wide membership that also names scope ids', () => {
      expect(() => invitation({ scopeMode: 'ORG_WIDE', scopeIds: [newId()] })).toThrow(/names no scope ids/);
    });

    it('refuses a narrowed membership that names nothing', () => {
      expect(() => invitation({ scopeMode: 'TERMINAL', scopeIds: [] })).toThrow(/at least one id/);
    });

    it('accepts a narrowed membership with the ids it is limited to', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      const terminal = newId();
      const member = await inOrg(admin, orgId, () =>
        addMember(invitation({ scopeMode: 'TERMINAL', scopeIds: [terminal] }), adminId),
      );
      expect(member.scopeMode).toBe('TERMINAL');
      expect(member.scopeIds).toEqual([terminal]);
    });
  });

  describe('people', () => {
    it('is one row per person, whichever organisation invites them', async () => {
      const first = await approvedOrganization();
      const second = await approvedOrganization({
        code: 'DEL-T1',
        legalName: 'Delhi Air Cargo Terminal Services Private Limited',
        primaryContact: { givenName: 'Meera', familyName: 'Nair', email: 'meera.nair@example.org' },
      });

      const here = await inOrg(first.admin, first.orgId, () => addMember(invitation(), first.adminId));
      const there = await inOrg(second.admin, second.orgId, () => addMember(invitation(), second.adminId));

      expect(there.user.id).toBe(here.user.id);
      const projected = await UserModel.findOne({ _id: here.user.id }).lean().exec();
      expect(projected?.memberships).toHaveLength(2);
      expect(projected?.memberships.every((m) => m.active)).toBe(true);
    });

    it('will not quietly turn staff into an assessor', async () => {
      const { orgId, admin, adminId } = await approvedOrganization();
      await inOrg(admin, orgId, () => addMember(invitation(), adminId));

      await expect(
        inOrg(admin, orgId, () => addMember(invitation({ kind: 'ASSESSOR', email: 'VIKRAM.IYER@example.org' }), adminId)),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('links an identity once and refuses to point it somewhere else', async () => {
      const created = await asSystem(() =>
        createUser({
          email: 'ops@example.org',
          givenName: 'Ops',
          familyName: 'Desk',
          kind: 'STAFF',
          phoneE164: null,
          whatsappOptIn: false,
        }),
      );
      expect(created.kcUserId).toBeNull();

      const linked = await asSystem(() => linkIdentity(created.id, 'kc-4f1a2b3c4d'));
      expect(linked.kcUserId).toBe('kc-4f1a2b3c4d');

      const authRow = await UserModel.findOne({ _id: created.id }).lean().exec();
      expect(authRow?.subject).toBe('kc-4f1a2b3c4d');

      await expect(asSystem(() => linkIdentity(created.id, 'kc-someone-else'))).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('suspends the account the kernel authenticates against', async () => {
      const { adminId } = await approvedOrganization();
      await asSystem(() => patchUser(adminId, { status: 'SUSPENDED' }));

      const authRow = await UserModel.findOne({ _id: adminId }).lean().exec();
      expect(authRow?.status).toBe('SUSPENDED');
    });

    it('filters the directory by whether an account can sign in yet', async () => {
      await approvedOrganization();
      const unlinked = await asSystem(() => listUsers(UserListQuery.parse({ linked: 'false' })));
      expect(unlinked.page.total).toBe(1);

      const linked = await asSystem(() => listUsers(UserListQuery.parse({ linked: 'true' })));
      expect(linked.page.total).toBe(0);
    });
  });

  describe('the registry', () => {
    it('pages, sorts and filters', async () => {
      await approvedOrganization();
      await approvedOrganization({
        code: 'DEL-T1',
        legalName: 'Delhi Air Cargo Terminal Services Private Limited',
        primaryContact: { givenName: 'Meera', familyName: 'Nair', email: 'meera.nair@example.org' },
      });

      const all = await asSystem(() => listOrganizations(OrgListQuery.parse({})));
      expect(all.page.total).toBe(2);
      expect(all.items.map((o) => o.code)).toEqual(['BOM-T2', 'DEL-T1']);

      const searched = await asSystem(() => listOrganizations(OrgListQuery.parse({ q: 'del' })));
      expect(searched.items.map((o) => o.code)).toEqual(['DEL-T1']);

      const filtered = await asSystem(() =>
        listOrganizations(OrgListQuery.parse({ state: 'PENDING_APPROVAL' })),
      );
      expect(filtered.page.total).toBe(0);
    });

    it('reports the caller own organisations for the switcher, and nothing else', async () => {
      const { orgId, admin } = await approvedOrganization();
      await approvedOrganization({
        code: 'DEL-T1',
        legalName: 'Delhi Air Cargo Terminal Services Private Limited',
        primaryContact: { givenName: 'Meera', familyName: 'Nair', email: 'meera.nair@example.org' },
      });

      const mine = await myMemberships(admin);
      expect(mine.map((m) => m.orgId)).toEqual([orgId]);
      expect(mine[0]?.capabilities).toContain('orgs.members:write');
    });
  });

  describe('platform capability', () => {
    it('refuses a capability granted outside an organisation that administers others', async () => {
      const { admin } = await approvedOrganization();
      const pretender: Principal = {
        ...admin,
        memberships: [
          { orgId: admin.memberships[0]?.orgId ?? '', roles: ['ACO_ADMIN'], capabilities: ['orgs.registry:write'], active: true },
        ],
      };

      await expect(asSystem(() => assertPlatformCapability(pretender, 'orgs.registry:write'))).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      );
    });

    it('accepts it when the granting organisation is the platform itself', async () => {
      const platform = await asSystem(() =>
        createOrganization({
          legalName: 'Air Cargo Forum India',
          displayName: null,
          code: 'ACFI',
          airportId: null,
          address: { city: 'Mumbai', state: 'Maharashtra', country: 'IN', region: 'West' },
          registrationIds: { cin: null, gstin: null, pan: null },
          formScope: null,
          type: 'PLATFORM',
          samplingApprovalMode: 'SUPER_ADMIN',
          primaryContact: {
            givenName: 'Asha',
            familyName: 'Rao',
            email: 'asha.rao@example.org',
            phoneE164: null,
            whatsappOptIn: false,
          },
        }),
      );
      await asSystem(() => transitionOrganization(platform.id, { action: 'SUBMIT' }, null));
      await asSystem(() => transitionOrganization(platform.id, { action: 'APPROVE' }, null));

      const membership = await asSystem(() =>
        MembershipModel.findOne({ orgId: platform.id, isActive: true }).lean().exec(),
      );
      if (!membership) throw new Error('the platform has no administrator');
      const principal = await principalFromProjection(membership.userId);

      await expect(
        asSystem(() => assertPlatformCapability(principal, 'orgs.registry:write')),
      ).resolves.toBeDefined();
    });

    it('is needed because the router own guard cannot refuse anything in system scope', () => {
      // the router enters system scope before it checks the capability a
      // platform route declares, and in system scope every capability answers
      // true. This is why the module checks it again for itself
      expect(() => asSystem(() => requireCapability('orgs.registry:write'))).not.toThrow();
      expect(() => asSystem(() => requireCapability('nothing:granted'))).not.toThrow();
    });

    it('refuses an unauthenticated caller', async () => {
      await expect(asSystem(() => assertPlatformCapability(undefined, 'orgs.registry:read'))).rejects.toMatchObject(
        { code: 'UNAUTHENTICATED' },
      );
    });
  });
});
