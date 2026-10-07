import { Types } from 'mongoose';
import { z } from 'zod';

import { AppError } from './errors.js';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** zod schema for an ObjectId string on the wire (path params, bodies). */
export const idSchema = z.string().regex(OBJECT_ID, 'must be a 24-character hex id');

export function isIdString(value: string): boolean {
  return OBJECT_ID.test(value);
}

/** Converts a validated id string to an ObjectId; throws VALIDATION otherwise. */
export function toId(value: string, what = 'id'): Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new AppError('VALIDATION', `Invalid ${what}: ${value}`);
  return new Types.ObjectId(value);
}

export function idString(value: Types.ObjectId | string): string {
  return typeof value === 'string' ? value : value.toHexString();
}

export function sameId(a: Types.ObjectId | string, b: Types.ObjectId | string): boolean {
  return idString(a) === idString(b);
}

export function newId(): Types.ObjectId {
  return new Types.ObjectId();
}
