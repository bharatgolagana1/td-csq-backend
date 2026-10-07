// Draft editing: categories, subcategories and questions of a DRAFT version,
// and the one-shot reorder. Every write first proves the version is a draft
// (412 otherwise) and every node lookup is scoped by the survey (404 otherwise).
// Draft edits are not audited; publishing is (ARCHITECTURE §7).
import type { Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';

import { CategoryModel, type CategoryDoc } from './categories.model.js';
import { QuestionModel, type QuestionDoc } from './questions.model.js';
import { SubcategoryModel, type SubcategoryDoc } from './subcategories.model.js';
import type { SurveyDoc } from './surveys.model.js';
import type {
  CategoryNodeDto,
  CreateCategoryInput,
  CreateQuestionInput,
  CreateSubcategoryInput,
  Issue,
  OrderInput,
  PatchCategoryInput,
  PatchQuestionInput,
  PatchSubcategoryInput,
  QuestionDto,
  SubcategoryNodeDto,
  SurveyTreeDto,
} from './surveys.schemas.js';
import {
  getSurveyTree,
  loadSurveyTreeDocs,
  requireSurvey,
  toCategoryNodeDto,
  toQuestionDto,
  toSubcategoryNodeDto,
} from './surveys.service.js';

async function requireDraft(surveyId: string): Promise<SurveyDoc> {
  const survey = await requireSurvey(surveyId);
  if (survey.status !== 'DRAFT') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Survey version ${survey.version} is ${survey.status.toLowerCase()} and cannot be edited; create a new draft version`,
      { surveyId, status: survey.status },
    );
  }
  return survey;
}

function nextOrder(last: { order: number } | null): number {
  return (last?.order ?? 0) + 1;
}

async function requireCategory(surveyId: Types.ObjectId, catId: string): Promise<CategoryDoc> {
  const doc = await CategoryModel.findOne({ _id: toId(catId), surveyId }).lean<CategoryDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Category not found');
  return doc;
}

async function requireSubcategory(surveyId: Types.ObjectId, subId: string): Promise<SubcategoryDoc> {
  const doc = await SubcategoryModel.findOne({ _id: toId(subId), surveyId }).lean<SubcategoryDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Subcategory not found');
  return doc;
}

async function requireQuestion(surveyId: Types.ObjectId, qId: string): Promise<QuestionDoc> {
  const doc = await QuestionModel.findOne({ _id: toId(qId), surveyId }).lean<QuestionDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Question not found');
  return doc;
}

/** A parent named in a body is an input, so an unknown one is VALIDATION (like an unknown airport), not 404. */
async function resolveParent(
  surveyId: Types.ObjectId,
  categoryId: string,
  subcategoryId: string | null,
): Promise<{ categoryId: Types.ObjectId; subcategoryId: Types.ObjectId | null }> {
  const category = await CategoryModel.findOne({ _id: toId(categoryId), surveyId }).lean<CategoryDoc>();
  if (!category) throw new AppError('VALIDATION', 'Unknown category', { categoryId });
  if (subcategoryId === null) return { categoryId: category._id, subcategoryId: null };
  const sub = await SubcategoryModel.findOne({ _id: toId(subcategoryId), surveyId }).lean<SubcategoryDoc>();
  if (!sub) throw new AppError('VALIDATION', 'Unknown subcategory', { subcategoryId });
  if (!sub.categoryId.equals(category._id)) {
    throw new AppError('VALIDATION', `Subcategory ${sub.code} does not belong to category ${category.code}`, { categoryId, subcategoryId });
  }
  return { categoryId: category._id, subcategoryId: sub._id };
}

async function assertCategoryCodeFree(surveyId: Types.ObjectId, code: string, except?: Types.ObjectId): Promise<void> {
  const clash = await CategoryModel.exists({ surveyId, code, ...(except ? { _id: { $ne: except } } : {}) });
  if (clash) throw new AppError('CONFLICT', `Category code ${code} already exists in this survey`);
}

async function assertSubcategoryCodeFree(surveyId: Types.ObjectId, code: string, except?: Types.ObjectId): Promise<void> {
  const clash = await SubcategoryModel.exists({ surveyId, code, ...(except ? { _id: { $ne: except } } : {}) });
  if (clash) throw new AppError('CONFLICT', `Subcategory code ${code} already exists in this survey`);
}

async function assertQuestionCodeFree(surveyId: Types.ObjectId, code: string, except?: Types.ObjectId): Promise<void> {
  const clash = await QuestionModel.exists({ surveyId, code, ...(except ? { _id: { $ne: except } } : {}) });
  if (clash) throw new AppError('CONFLICT', `Question code ${code} already exists in this survey`);
}

// --- categories ------------------------------------------------------------

export async function createCategory(ctx: RequestContext, surveyId: string, input: CreateCategoryInput): Promise<CategoryNodeDto> {
  const survey = await requireDraft(surveyId);
  await assertCategoryCodeFree(survey._id, input.code);
  const order =
    input.order ?? nextOrder(await CategoryModel.findOne({ surveyId: survey._id }).sort({ order: -1 }).lean<Pick<CategoryDoc, 'order'>>());
  const created = await CategoryModel.create({
    surveyId: survey._id,
    code: input.code,
    name: input.name,
    order,
    weightPct: input.weightPct ?? null,
  });
  return toCategoryNodeDto(created.toObject());
}

export async function updateCategory(ctx: RequestContext, surveyId: string, catId: string, patch: PatchCategoryInput): Promise<CategoryNodeDto> {
  const survey = await requireDraft(surveyId);
  const before = await requireCategory(survey._id, catId);
  if (patch.code !== undefined && patch.code !== before.code) await assertCategoryCodeFree(survey._id, patch.code, before._id);
  const $set: Partial<CategoryDoc> = {};
  if (patch.code !== undefined) $set.code = patch.code;
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.order !== undefined) $set.order = patch.order;
  if (patch.weightPct !== undefined) $set.weightPct = patch.weightPct;
  const after = await CategoryModel.findOneAndUpdate({ _id: before._id }, { $set }, { new: true }).lean<CategoryDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Category not found');
  return toCategoryNodeDto(after);
}

/** Removes the category with its subcategories and questions. */
export async function deleteCategory(ctx: RequestContext, surveyId: string, catId: string): Promise<void> {
  const survey = await requireDraft(surveyId);
  const category = await requireCategory(survey._id, catId);
  await withTransaction(async (session) => {
    await QuestionModel.deleteMany({ surveyId: survey._id, categoryId: category._id }, { session });
    await SubcategoryModel.deleteMany({ surveyId: survey._id, categoryId: category._id }, { session });
    await CategoryModel.deleteOne({ _id: category._id }, { session });
  });
}

// --- subcategories ---------------------------------------------------------

export async function createSubcategory(ctx: RequestContext, surveyId: string, input: CreateSubcategoryInput): Promise<SubcategoryNodeDto> {
  const survey = await requireDraft(surveyId);
  const parent = await resolveParent(survey._id, input.categoryId, null);
  await assertSubcategoryCodeFree(survey._id, input.code);
  const order =
    input.order ??
    nextOrder(
      await SubcategoryModel.findOne({ surveyId: survey._id, categoryId: parent.categoryId }).sort({ order: -1 }).lean<Pick<SubcategoryDoc, 'order'>>(),
    );
  const created = await SubcategoryModel.create({
    surveyId: survey._id,
    categoryId: parent.categoryId,
    code: input.code,
    name: input.name,
    order,
  });
  return toSubcategoryNodeDto(created.toObject());
}

/** Moving a subcategory to another category takes its questions along. */
export async function updateSubcategory(
  ctx: RequestContext,
  surveyId: string,
  subId: string,
  patch: PatchSubcategoryInput,
): Promise<SubcategoryNodeDto> {
  const survey = await requireDraft(surveyId);
  const before = await requireSubcategory(survey._id, subId);
  if (patch.code !== undefined && patch.code !== before.code) await assertSubcategoryCodeFree(survey._id, patch.code, before._id);
  const $set: Partial<SubcategoryDoc> = {};
  if (patch.code !== undefined) $set.code = patch.code;
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.order !== undefined) $set.order = patch.order;
  const moveTo = patch.categoryId !== undefined && patch.categoryId !== idString(before.categoryId) ? patch.categoryId : null;
  if (moveTo !== null) $set.categoryId = (await resolveParent(survey._id, moveTo, null)).categoryId;

  const after = await withTransaction(async (session) => {
    const updated = await SubcategoryModel.findOneAndUpdate({ _id: before._id }, { $set }, { new: true, session }).lean<SubcategoryDoc>();
    if (!updated) throw new AppError('NOT_FOUND', 'Subcategory not found');
    if (moveTo !== null) {
      await QuestionModel.updateMany({ surveyId: survey._id, subcategoryId: before._id }, { $set: { categoryId: updated.categoryId } }, { session });
    }
    return updated;
  });
  return toSubcategoryNodeDto(after);
}

/** Removes the subcategory with its questions. */
export async function deleteSubcategory(ctx: RequestContext, surveyId: string, subId: string): Promise<void> {
  const survey = await requireDraft(surveyId);
  const sub = await requireSubcategory(survey._id, subId);
  await withTransaction(async (session) => {
    await QuestionModel.deleteMany({ surveyId: survey._id, subcategoryId: sub._id }, { session });
    await SubcategoryModel.deleteOne({ _id: sub._id }, { session });
  });
}

// --- questions -------------------------------------------------------------

async function lastSiblingQuestion(
  surveyId: Types.ObjectId,
  parent: { categoryId: Types.ObjectId; subcategoryId: Types.ObjectId | null },
): Promise<Pick<QuestionDoc, 'order'> | null> {
  return QuestionModel.findOne({ surveyId, categoryId: parent.categoryId, subcategoryId: parent.subcategoryId })
    .sort({ order: -1 })
    .lean<Pick<QuestionDoc, 'order'>>();
}

export async function createQuestion(ctx: RequestContext, surveyId: string, input: CreateQuestionInput): Promise<QuestionDto> {
  const survey = await requireDraft(surveyId);
  const parent = await resolveParent(survey._id, input.categoryId, input.subcategoryId ?? null);
  await assertQuestionCodeFree(survey._id, input.code);
  const order = input.order ?? nextOrder(await lastSiblingQuestion(survey._id, parent));
  const created = await QuestionModel.create({
    surveyId: survey._id,
    categoryId: parent.categoryId,
    subcategoryId: parent.subcategoryId,
    code: input.code,
    text: input.text,
    help: input.help ?? null,
    order,
    weightPct: input.weightPct ?? null,
    mandatory: input.mandatory,
    commentMode: input.commentMode,
    stakeholderTypes: input.stakeholderTypes,
    followUp: input.followUp ?? null,
    active: input.active,
  });
  return toQuestionDto(created.toObject());
}

export async function updateQuestion(ctx: RequestContext, surveyId: string, qId: string, patch: PatchQuestionInput): Promise<QuestionDto> {
  const survey = await requireDraft(surveyId);
  const before = await requireQuestion(survey._id, qId);
  if (patch.code !== undefined && patch.code !== before.code) await assertQuestionCodeFree(survey._id, patch.code, before._id);

  const $set: Partial<QuestionDoc> = {};
  if (patch.categoryId !== undefined || patch.subcategoryId !== undefined) {
    // A new parent is validated as a whole: the subcategory (kept or given) must belong to the category (kept or given).
    const categoryId = patch.categoryId ?? idString(before.categoryId);
    const subcategoryId =
      patch.subcategoryId !== undefined ? patch.subcategoryId : before.subcategoryId ? idString(before.subcategoryId) : null;
    const parent = await resolveParent(survey._id, categoryId, subcategoryId);
    $set.categoryId = parent.categoryId;
    $set.subcategoryId = parent.subcategoryId;
    const moved = !parent.categoryId.equals(before.categoryId) || !sameOptionalId(parent.subcategoryId, before.subcategoryId);
    if (moved && patch.order === undefined) $set.order = nextOrder(await lastSiblingQuestion(survey._id, parent));
  }
  if (patch.code !== undefined) $set.code = patch.code;
  if (patch.text !== undefined) $set.text = patch.text;
  if (patch.help !== undefined) $set.help = patch.help;
  if (patch.order !== undefined) $set.order = patch.order;
  if (patch.weightPct !== undefined) $set.weightPct = patch.weightPct;
  if (patch.mandatory !== undefined) $set.mandatory = patch.mandatory;
  if (patch.commentMode !== undefined) $set.commentMode = patch.commentMode;
  if (patch.stakeholderTypes !== undefined) $set.stakeholderTypes = patch.stakeholderTypes;
  if (patch.followUp !== undefined) $set.followUp = patch.followUp;
  if (patch.active !== undefined) $set.active = patch.active;

  const after = await QuestionModel.findOneAndUpdate({ _id: before._id }, { $set }, { new: true }).lean<QuestionDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Question not found');
  return toQuestionDto(after);
}

function sameOptionalId(a: Types.ObjectId | null, b: Types.ObjectId | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

export async function deleteQuestion(ctx: RequestContext, surveyId: string, qId: string): Promise<void> {
  const survey = await requireDraft(surveyId);
  const question = await requireQuestion(survey._id, qId);
  await QuestionModel.deleteOne({ _id: question._id });
}

// --- order -----------------------------------------------------------------

interface OrderUpdate {
  id: Types.ObjectId;
  order: number;
}

/**
 * `PUT /surveys/:id/order`: sets `order` on every listed node. Each node must
 * exist in this survey and be listed under its actual parent (the endpoint
 * orders, it does not move; PATCH moves). Nodes not listed keep their order.
 */
export async function reorderSurvey(ctx: RequestContext, surveyId: string, input: OrderInput): Promise<SurveyTreeDto> {
  await requireDraft(surveyId);
  const docs = await loadSurveyTreeDocs(surveyId);
  const categories = new Map(docs.categories.map((doc) => [idString(doc._id), doc]));
  const subcategories = new Map(docs.subcategories.map((doc) => [idString(doc._id), doc]));
  const questions = new Map(docs.questions.map((doc) => [idString(doc._id), doc]));

  const issues: Issue[] = [];
  const seen = new Set<string>();
  const updates = { categories: [] as OrderUpdate[], subcategories: [] as OrderUpdate[], questions: [] as OrderUpdate[] };

  const place = (path: string, id: string, order: number, doc: { _id: Types.ObjectId } | undefined, what: string, into: OrderUpdate[]): boolean => {
    if (!doc) {
      issues.push({ path, message: `Unknown ${what} ${id}` });
      return false;
    }
    if (seen.has(id)) {
      issues.push({ path, message: `${what} ${id} is listed twice` });
      return false;
    }
    seen.add(id);
    into.push({ id: doc._id, order });
    return true;
  };

  const placeQuestions = (
    path: string,
    entries: readonly { id: string; order: number }[],
    categoryId: Types.ObjectId,
    subcategoryId: Types.ObjectId | null,
  ): void => {
    entries.forEach((entry, index) => {
      const doc = questions.get(entry.id);
      if (!place(`${path}.${index}.id`, entry.id, entry.order, doc, 'question', updates.questions) || !doc) return;
      if (!doc.categoryId.equals(categoryId) || !sameOptionalId(doc.subcategoryId, subcategoryId)) {
        issues.push({ path: `${path}.${index}.id`, message: `Question ${doc.code} is not under this parent; move it with PATCH first` });
      }
    });
  };

  input.categories.forEach((entry, index) => {
    const path = `categories.${index}`;
    const category = categories.get(entry.id);
    if (!place(`${path}.id`, entry.id, entry.order, category, 'category', updates.categories) || !category) return;
    placeQuestions(`${path}.questions`, entry.questions ?? [], category._id, null);
    (entry.subcategories ?? []).forEach((subEntry, subIndex) => {
      const subPath = `${path}.subcategories.${subIndex}`;
      const sub = subcategories.get(subEntry.id);
      if (!place(`${subPath}.id`, subEntry.id, subEntry.order, sub, 'subcategory', updates.subcategories) || !sub) return;
      if (!sub.categoryId.equals(category._id)) {
        issues.push({ path: `${subPath}.id`, message: `Subcategory ${sub.code} is not under category ${category.code}; move it with PATCH first` });
        return;
      }
      placeQuestions(`${subPath}.questions`, subEntry.questions ?? [], category._id, sub._id);
    });
  });
  if (issues.length > 0) throw new AppError('VALIDATION', 'Invalid order', { issues });

  const ops = (list: OrderUpdate[]) => list.map((update) => ({ updateOne: { filter: { _id: update.id }, update: { $set: { order: update.order } } } }));
  await withTransaction(async (session) => {
    if (updates.categories.length > 0) await CategoryModel.bulkWrite(ops(updates.categories), { session });
    if (updates.subcategories.length > 0) await SubcategoryModel.bulkWrite(ops(updates.subcategories), { session });
    if (updates.questions.length > 0) await QuestionModel.bulkWrite(ops(updates.questions), { session });
  });
  return getSurveyTree(surveyId);
}
