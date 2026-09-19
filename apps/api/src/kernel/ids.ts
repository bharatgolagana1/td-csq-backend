import { ulid } from 'ulid';

/**
 * Every document this API creates carries a ULID string _id. Mongo's ObjectId
 * leaks creation timestamps in a shape people have learned to scrape, and it is
 * not a valid value for the contract types the frontend already compiles against.
 */
export function newId(): string {
  return ulid();
}
