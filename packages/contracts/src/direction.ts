import { z } from 'zod';

/**
 * Every question is answered twice, once per direction. International terminals
 * are rated on export and import; domestic terminals on inbound and outbound.
 *
 * The question text is stored once and carries both directions, rather than the
 * bank holding two near-identical questions. That keeps cross-form analytics
 * possible and means editing a question's wording cannot drift between columns.
 */
export const Direction = z.enum(['EXPORT', 'IMPORT', 'INBOUND', 'OUTBOUND']);
export type Direction = z.infer<typeof Direction>;

export const FormScope = z.enum(['INTERNATIONAL', 'DOMESTIC']);
export type FormScope = z.infer<typeof FormScope>;

export const DIRECTION_SETS = {
  EXIM: ['EXPORT', 'IMPORT'],
  DOMESTIC_FLOW: ['INBOUND', 'OUTBOUND'],
} as const satisfies Record<string, readonly Direction[]>;

export const DIRECTIONS_BY_SCOPE: Readonly<Record<FormScope, readonly Direction[]>> = Object.freeze({
  INTERNATIONAL: DIRECTION_SETS.EXIM,
  DOMESTIC: DIRECTION_SETS.DOMESTIC_FLOW,
});

export function directionsFor(scope: FormScope): readonly Direction[] {
  return DIRECTIONS_BY_SCOPE[scope];
}

/** Guards against an inbound answer arriving on an international form. */
export function isDirectionValidFor(scope: FormScope, direction: Direction): boolean {
  return DIRECTIONS_BY_SCOPE[scope].includes(direction);
}
