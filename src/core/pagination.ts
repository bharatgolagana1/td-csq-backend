import type { FilterQuery } from 'mongoose';
import { z } from 'zod';

import { AppError } from './errors.js';

/** `?page=1&pageSize=25&sort=-createdAt&q=` — every [list] endpoint extends this. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().max(200).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * A page of results. `route()` serialises a Page as `{ data, meta }` instead of
 * wrapping it in `{ data }`, so list handlers return `pageOf(...)`.
 */
export class Page<T> {
  constructor(
    readonly data: T[],
    readonly meta: PageMeta,
  ) {}
}

export function pageOf<T>(data: T[], total: number, query: Pick<ListQuery, 'page' | 'pageSize'>): Page<T> {
  return new Page(data, { page: query.page, pageSize: query.pageSize, total });
}

export function skipLimit(query: Pick<ListQuery, 'page' | 'pageSize'>): { skip: number; limit: number } {
  return { skip: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

export type SortSpec = Record<string, 1 | -1>;

/**
 * Parses `sort=-createdAt,name` against an allow-list of fields. Unknown
 * fields are a VALIDATION error so sort cannot probe the schema.
 */
export function parseSort(sort: string | undefined, allowed: readonly string[], fallback: string): SortSpec {
  const spec: SortSpec = {};
  for (const part of (sort ?? fallback).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const direction: 1 | -1 = trimmed.startsWith('-') ? -1 : 1;
    const field = trimmed.replace(/^[-+]/, '');
    if (!allowed.includes(field)) {
      throw new AppError('VALIDATION', `Cannot sort by "${field}"`, { allowed });
    }
    spec[field] = direction;
  }
  return Object.keys(spec).length > 0 ? spec : parseSort(undefined, allowed, fallback);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive "contains" filter over the given fields, or `{}` when `q` is empty. */
export function searchFilter<T>(q: string | undefined, fields: readonly string[]): FilterQuery<T> {
  if (!q) return {};
  const regex = new RegExp(escapeRegex(q), 'i');
  return { $or: fields.map((field) => ({ [field]: regex })) } as FilterQuery<T>;
}
