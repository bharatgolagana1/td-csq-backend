import { z } from 'zod';
import { Ulid } from '@csq/contracts';
import {
  GLOBAL_AREA_KEYS,
  ORG_AREA_KEYS,
  SELF_AREA_KEYS,
  type AreaScope,
  type AreaValue,
  type SettingsCapability,
} from './settings.areas.js';

/**
 * The wire shapes. The payload of any one area is validated by that area's own
 * schema in the registry, so what lives here is the envelope around it: which
 * area, which revision it was based on, and how a list is addressed.
 */

const HexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a six digit hex colour');

export const OrgAreaParams = z.object({ key: z.enum(ORG_AREA_KEYS) });
export const SelfAreaParams = z.object({ key: z.enum(SELF_AREA_KEYS) });
export const GlobalAreaParams = z.object({ key: z.enum(GLOBAL_AREA_KEYS) });

/**
 * A patch states the revision it was based on. Two administrators on two tabs
 * of the same screen is normal, and a write that ignores what happened in
 * between silently discards whichever of them saved first.
 */
export const AreaPatchBody = z
  .object({
    expectedRevision: z.number().int().min(0).optional(),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AreaPatchBody = z.infer<typeof AreaPatchBody>;

export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface CatalogueEntry {
  readonly key: string;
  readonly scope: AreaScope;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  /** Where the frontend navigates. */
  readonly route: string;
  /** Where the frontend reads and writes it. Built here, never in the client. */
  readonly api: string;
  readonly readCapability: SettingsCapability | null;
  readonly writeCapability: SettingsCapability | null;
  /** False renders the area read only rather than letting a save fail with 403. */
  readonly writable: boolean;
}

export interface AreaView {
  readonly key: string;
  readonly scope: AreaScope;
  /** 0 means nothing has ever been saved and every value below is a default. */
  readonly revision: number;
  readonly defaultsApplied: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly value: AreaValue;
}

export interface AuditEntryView {
  readonly id: string;
  readonly areaKey: string;
  readonly actorUserId: string | null;
  readonly at: string;
  readonly before: AreaValue;
  readonly after: AreaValue;
}

/**
 * Curated lists an organisation maintains for itself. These are not reference
 * data: nothing is seeded, every entry is typed in by an administrator, and the
 * set of kinds is the contract while the contents are the tenant's.
 */
export const LIST_KINDS = ['CONTACT_TAG', 'CUSTOMER_SEGMENT', 'DECLINE_REASON', 'TERMINAL_AREA'] as const;
export const ListKind = z.enum(LIST_KINDS);
export type ListKind = z.infer<typeof ListKind>;

export const ListItemView = z.object({
  id: Ulid,
  kind: ListKind,
  label: z.string(),
  colour: HexColour.nullable(),
  position: z.number().int().min(0),
  archived: z.boolean(),
});
export type ListItemView = z.infer<typeof ListItemView>;

export const CreateListItem = z
  .object({
    label: z.string().min(1).max(80),
    colour: HexColour.nullable().default(null),
  })
  .strict();

export const UpdateListItem = z
  .object({
    label: z.string().min(1).max(80).optional(),
    colour: HexColour.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');

export const ReorderList = z
  .object({
    /** Must be every live item of this kind, exactly once. */
    itemIds: z.array(Ulid).min(1).max(500),
  })
  .strict();

export const ListKindParam = z.object({ kind: ListKind });
export const ListItemParams = z.object({ kind: ListKind, itemId: Ulid });
export const ListQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
