import type { Request } from 'express';
import type { z } from 'zod';
import { fromZod } from './errors.js';

/**
 * Nothing reaches a handler unparsed. Each helper returns the inferred type, so
 * a handler that wants a field the schema does not declare fails to compile.
 */

export function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}
