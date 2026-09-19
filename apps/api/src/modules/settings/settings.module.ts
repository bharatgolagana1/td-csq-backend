import { defineModule } from '../../kernel/router.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import {
  ALL_AREAS,
  LINK_AREAS,
  SETTINGS_BASE_PATH,
  SETTINGS_CAPABILITIES,
  type SettingsCapability,
} from './settings.areas.js';
import {
  AreaPatchBody,
  AuditQuery,
  CreateListItem,
  GlobalAreaParams,
  ListItemParams,
  ListKindParam,
  ListQuery,
  OrgAreaParams,
  ReorderList,
  SelfAreaParams,
  UpdateListItem,
} from './settings.contracts.js';
import {
  buildCatalogue,
  patchGlobalArea,
  patchOrgArea,
  patchSelfArea,
  readGlobalArea,
  readGlobalAreaAudit,
  readHub,
  readOrgArea,
  readOrgAreaAudit,
  readSelfArea,
  readSelfAreaAudit,
} from './settings.service.js';
import {
  addListItem,
  archiveListItem,
  editListItem,
  readList,
  reorderList,
  summariseLists,
} from './settings.lists.service.js';

export const SETTINGS_READ = 'settings:read';
export const SETTINGS_WRITE = 'settings:write';
export const SETTINGS_LISTS_WRITE = 'settings.lists:write';

/**
 * Every capability the registry names is declared to the router. The type
 * already forbids inventing one, and this repeats the check at boot so a change
 * to either list cannot leave a route permanently ungrantable.
 */
function assertRegistryCapabilitiesAreDeclared(declared: readonly SettingsCapability[]): void {
  const known = new Set<string>(declared);
  const used: Array<SettingsCapability | null> = [
    ...ALL_AREAS.flatMap((area) => [area.readCapability, area.writeCapability]),
    ...LINK_AREAS.flatMap((link) => [link.readCapability, link.writeCapability]),
  ];
  for (const capability of used) {
    if (capability !== null && !known.has(capability)) {
      throw new Error(`settings: area capability ${capability} is not declared by the module`);
    }
  }
}

assertRegistryCapabilitiesAreDeclared(SETTINGS_CAPABILITIES);

/**
 * The platform areas are SELF routes rather than PLATFORM ones. A PLATFORM
 * route enters a system scope, and a system scope carries no principal and
 * passes the kernel's capability guard unconditionally, so the actor behind a
 * change to a platform wide setting would be unknown and the guard would gate
 * nothing. These routes keep the principal and the service checks the platform
 * capability against that person's memberships, which is a real gate and an
 * attributable audit row.
 */
const PLATFORM_OPEN_REASON =
  'Gated on settings.platform held in an active membership, checked in the service: a self scope carries no organisation capabilities for the kernel guard to read';

export const settingsModule = defineModule({
  name: 'settings',
  basePath: SETTINGS_BASE_PATH,
  capabilities: [...SETTINGS_CAPABILITIES],
  routes: [
    {
      method: 'get',
      path: '/',
      summary: 'Everything the settings screen opens with',
      policy: {
        requiredCapability: null,
        tenancy: 'ORG',
        openReason: 'The hub is the caller own menu and already lists only the areas their capabilities allow',
      },
      handler: () => readHub(),
    },
    {
      method: 'get',
      path: '/catalogue',
      summary: 'The settings areas this caller may open',
      policy: {
        requiredCapability: null,
        tenancy: 'ORG',
        openReason: 'Every entry returned is one the caller already holds the capability to read',
      },
      handler: () => buildCatalogue(),
    },
    {
      method: 'get',
      path: '/org/:key',
      summary: 'Read one organisation settings area',
      policy: { requiredCapability: SETTINGS_READ, tenancy: 'ORG' },
      handler: (req) => readOrgArea(parseParams(OrgAreaParams, req).key),
    },
    {
      method: 'patch',
      path: '/org/:key',
      summary: 'Update one organisation settings area',
      policy: { requiredCapability: SETTINGS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { key } = parseParams(OrgAreaParams, req);
        const body = parseBody(AreaPatchBody, req);
        return patchOrgArea(key, body.value, body.expectedRevision);
      },
    },
    {
      method: 'get',
      path: '/org/:key/audit',
      summary: 'Who changed an organisation settings area, and to what',
      policy: { requiredCapability: SETTINGS_READ, tenancy: 'ORG' },
      handler: (req) => {
        const { key } = parseParams(OrgAreaParams, req);
        const { limit } = parseQuery(AuditQuery, req);
        return readOrgAreaAudit(key, limit);
      },
    },
    {
      method: 'get',
      path: '/me/:key',
      summary: 'Read one of the calling user own settings areas',
      policy: {
        requiredCapability: null,
        tenancy: 'SELF',
        openReason: 'Reads only the calling user own row; a capability would lock people out of their own settings',
      },
      handler: (req) => readSelfArea(parseParams(SelfAreaParams, req).key),
    },
    {
      method: 'patch',
      path: '/me/:key',
      summary: 'Update one of the calling user own settings areas',
      policy: {
        requiredCapability: null,
        tenancy: 'SELF',
        openReason: 'Writes only the calling user own row, never anyone else',
      },
      handler: (req) => {
        const { key } = parseParams(SelfAreaParams, req);
        const body = parseBody(AreaPatchBody, req);
        return patchSelfArea(key, body.value, body.expectedRevision);
      },
    },
    {
      method: 'get',
      path: '/me/:key/audit',
      summary: 'What the calling user changed in their own settings',
      policy: {
        requiredCapability: null,
        tenancy: 'SELF',
        openReason: 'Reads only the calling user own audit rows, never anyone else',
      },
      handler: (req) => {
        const { key } = parseParams(SelfAreaParams, req);
        const { limit } = parseQuery(AuditQuery, req);
        return readSelfAreaAudit(key, limit);
      },
    },
    {
      method: 'get',
      path: '/platform/:key',
      summary: 'Read one platform wide settings area',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_OPEN_REASON },
      handler: (req) => readGlobalArea(parseParams(GlobalAreaParams, req).key),
    },
    {
      method: 'patch',
      path: '/platform/:key',
      summary: 'Update one platform wide settings area',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_OPEN_REASON },
      handler: (req) => {
        const { key } = parseParams(GlobalAreaParams, req);
        const body = parseBody(AreaPatchBody, req);
        return patchGlobalArea(key, body.value, body.expectedRevision);
      },
    },
    {
      method: 'get',
      path: '/platform/:key/audit',
      summary: 'Who changed a platform settings area, and to what',
      policy: { requiredCapability: null, tenancy: 'SELF', openReason: PLATFORM_OPEN_REASON },
      handler: (req) => {
        const { key } = parseParams(GlobalAreaParams, req);
        const { limit } = parseQuery(AuditQuery, req);
        return readGlobalAreaAudit(key, limit);
      },
    },
    {
      method: 'get',
      path: '/lists',
      summary: 'Curated list kinds with their live entry counts',
      policy: { requiredCapability: SETTINGS_READ, tenancy: 'ORG' },
      handler: () => summariseLists(),
    },
    {
      method: 'get',
      path: '/lists/:kind',
      summary: 'Entries of one curated list',
      policy: { requiredCapability: SETTINGS_READ, tenancy: 'ORG' },
      handler: (req) => {
        const { kind } = parseParams(ListKindParam, req);
        const { includeArchived } = parseQuery(ListQuery, req);
        return readList(kind, includeArchived);
      },
    },
    {
      method: 'post',
      path: '/lists/:kind',
      summary: 'Add an entry to a curated list',
      status: 201,
      policy: { requiredCapability: SETTINGS_LISTS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { kind } = parseParams(ListKindParam, req);
        return addListItem(kind, parseBody(CreateListItem, req));
      },
    },
    {
      method: 'put',
      path: '/lists/:kind/order',
      summary: 'Reorder a curated list',
      policy: { requiredCapability: SETTINGS_LISTS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { kind } = parseParams(ListKindParam, req);
        const { itemIds } = parseBody(ReorderList, req);
        return reorderList(kind, itemIds);
      },
    },
    {
      method: 'patch',
      path: '/lists/:kind/:itemId',
      summary: 'Rename or recolour a list entry',
      policy: { requiredCapability: SETTINGS_LISTS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { kind, itemId } = parseParams(ListItemParams, req);
        return editListItem(kind, itemId, parseBody(UpdateListItem, req));
      },
    },
    {
      method: 'delete',
      path: '/lists/:kind/:itemId',
      summary: 'Archive a list entry',
      policy: { requiredCapability: SETTINGS_LISTS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { kind, itemId } = parseParams(ListItemParams, req);
        return archiveListItem(kind, itemId);
      },
    },
  ],
});
