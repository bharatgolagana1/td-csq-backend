import { conflict, fail, notFound } from '../../kernel/errors.js';
import { CategoryModel, type CategoryDoc } from './refdata.models.js';
import type { CategoryInput } from './refdata.contracts.js';

/**
 * The assessment heads. Phase 1 has four of them, and they arrive through the
 * seed from the ACFI forms rather than from a literal in a handler, so a change
 * to the instrument is a change to a reviewable file.
 */

export interface CategoryView {
  code: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
}

function toView(doc: CategoryDoc): CategoryView {
  return {
    code: doc.code,
    name: doc.name,
    description: doc.description,
    displayOrder: doc.displayOrder,
    isActive: doc.isActive,
  };
}

export async function listCategories(includeInactive: boolean): Promise<CategoryView[]> {
  const filter = includeInactive ? {} : { isActive: true };
  const rows = await CategoryModel.find(filter).sort({ displayOrder: 1, code: 1 }).lean().exec();
  return rows.map(toView);
}

export async function createCategory(input: CategoryInput): Promise<CategoryView> {
  const existing = await CategoryModel.findOne({ code: input.code }).lean().exec();
  if (existing) throw conflict(`Category ${input.code} already exists`);

  const created = await CategoryModel.create({ ...input });
  return toView(created.toObject());
}

/**
 * The code is not patchable. A published snapshot embeds the codes it was built
 * from, so renaming one would orphan every instrument that referenced it.
 */
export async function patchCategory(
  code: string,
  patch: Partial<Omit<CategoryInput, 'code'>>,
): Promise<CategoryView> {
  const updated = await CategoryModel.findOneAndUpdate({ code }, { $set: patch }, { new: true })
    .lean()
    .exec();
  if (!updated) throw notFound('No such category');
  return toView(updated);
}

/** Resolves the codes a bank version uses, refusing any that is missing or retired. */
export async function resolveActiveCategories(codes: readonly string[]): Promise<CategoryView[]> {
  const wanted = [...new Set(codes)];
  const rows = await CategoryModel.find({ code: { $in: wanted } })
    .sort({ displayOrder: 1 })
    .lean()
    .exec();

  const byCode = new Map(rows.map((row) => [row.code, row]));
  const problems: Array<{ path: string; message: string }> = [];
  for (const code of wanted) {
    const found = byCode.get(code);
    if (!found) problems.push({ path: `categories.${code}`, message: 'no such category' });
    else if (!found.isActive) problems.push({ path: `categories.${code}`, message: 'category is not active' });
  }
  if (problems.length > 0) {
    throw fail('VALIDATION_FAILED', 'The instrument names categories that cannot be used', problems);
  }
  return rows.map(toView);
}
