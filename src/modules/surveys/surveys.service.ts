// Survey versions: listing, the full tree, the next draft (a deep copy),
// publishing, and the read functions other modules depend on
// (`getPublishedSurvey`, `getSurveyTree`, `getFormForStakeholder`,
// `latestPublishedVersionIds`). Draft editing lives in survey-editor.service.ts.
import type { ClientSession, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString, newId, toId } from '../../core/ids.js';
import { audit } from '../audit/audit.service.js';

import { CategoryModel, type CategoryDoc } from './categories.model.js';
import { QuestionModel, type CommentMode, type FollowUp, type QuestionDoc, type StakeholderType } from './questions.model.js';
import { SubcategoryModel, type SubcategoryDoc } from './subcategories.model.js';
import { publishIssues, RATING_SCALE, toFormQuestion } from './survey-rules.js';
import { SURVEY_TYPES, SurveyModel, type SurveyDoc, type SurveyStatus, type SurveyType } from './surveys.model.js';
import type {
  CategoryDto,
  CategoryNodeDto,
  CreateVersionInput,
  FormCategoryDto,
  FormDto,
  FormSubcategoryDto,
  QuestionDto,
  SubcategoryDto,
  SubcategoryNodeDto,
  SurveyDto,
  SurveyListDto,
  SurveyTreeDto,
} from './surveys.schemas.js';

export const DEFAULT_SURVEY_NAMES: Record<SurveyType, string> = {
  DOMESTIC: 'Domestic Cargo Service Quality Survey',
  INTERNATIONAL: 'International Cargo Service Quality Survey',
};

export function isSurveyType(value: string): value is SurveyType {
  return (SURVEY_TYPES as readonly string[]).includes(value);
}

// --- views -----------------------------------------------------------------

export function toSurveyDto(doc: SurveyDoc): SurveyDto {
  return {
    id: idString(doc._id),
    code: doc.code,
    name: doc.name,
    version: doc.version,
    status: doc.status,
    publishedAt: doc.publishedAt?.toISOString() ?? null,
    publishedBy: doc.publishedBy ? idString(doc.publishedBy) : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toCategoryNodeDto(doc: CategoryDoc): CategoryNodeDto {
  return { id: idString(doc._id), code: doc.code, name: doc.name, order: doc.order, weightPct: doc.weightPct };
}

export function toSubcategoryNodeDto(doc: SubcategoryDoc): SubcategoryNodeDto {
  return { id: idString(doc._id), categoryId: idString(doc.categoryId), code: doc.code, name: doc.name, order: doc.order };
}

export function toQuestionDto(doc: QuestionDoc): QuestionDto {
  return {
    id: idString(doc._id),
    categoryId: idString(doc.categoryId),
    subcategoryId: doc.subcategoryId ? idString(doc.subcategoryId) : null,
    code: doc.code,
    text: doc.text,
    help: doc.help,
    order: doc.order,
    weightPct: doc.weightPct,
    mandatory: doc.mandatory,
    commentMode: doc.commentMode,
    stakeholderTypes: [...doc.stakeholderTypes],
    followUp: doc.followUp ? { prompt: doc.followUp.prompt, options: [...doc.followUp.options] } : null,
    active: doc.active,
  };
}

// --- lookups ---------------------------------------------------------------

export async function findSurveyById(id: string | Types.ObjectId): Promise<SurveyDoc | null> {
  return SurveyModel.findById(toId(idString(id), 'surveyId')).lean<SurveyDoc>();
}

export async function requireSurvey(id: string): Promise<SurveyDoc> {
  const doc = await findSurveyById(id);
  if (!doc) throw new AppError('NOT_FOUND', 'Survey not found');
  return doc;
}

/** The highest version of a type, whatever its status. */
export async function findLatestSurvey(type: SurveyType): Promise<SurveyDoc | null> {
  return SurveyModel.findOne({ code: type }).sort({ version: -1 }).lean<SurveyDoc>();
}

export interface SurveyTreeDocs {
  survey: SurveyDoc;
  categories: CategoryDoc[];
  subcategories: SubcategoryDoc[];
  questions: QuestionDoc[];
}

/** Every node of a version, each list already in display order. */
export async function loadSurveyTreeDocs(surveyId: string): Promise<SurveyTreeDocs> {
  const survey = await requireSurvey(surveyId);
  const [categories, subcategories, questions] = await Promise.all([
    CategoryModel.find({ surveyId: survey._id }).sort({ order: 1, code: 1 }).lean<CategoryDoc[]>(),
    SubcategoryModel.find({ surveyId: survey._id }).sort({ order: 1, code: 1 }).lean<SubcategoryDoc[]>(),
    QuestionModel.find({ surveyId: survey._id }).sort({ order: 1, code: 1 }).lean<QuestionDoc[]>(),
  ]);
  return { survey, categories, subcategories, questions };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function questionKey(categoryId: Types.ObjectId | string, subcategoryId: Types.ObjectId | string | null): string {
  return `${idString(categoryId)}:${subcategoryId ? idString(subcategoryId) : ''}`;
}

export function assembleCategories(docs: SurveyTreeDocs): CategoryDto[] {
  const subsByCategory = groupBy(docs.subcategories, (sub) => idString(sub.categoryId));
  const questionsByParent = groupBy(docs.questions, (question) => questionKey(question.categoryId, question.subcategoryId));
  return docs.categories.map((category) => ({
    ...toCategoryNodeDto(category),
    subcategories: (subsByCategory.get(idString(category._id)) ?? []).map(
      (sub): SubcategoryDto => ({
        ...toSubcategoryNodeDto(sub),
        questions: (questionsByParent.get(questionKey(category._id, sub._id)) ?? []).map(toQuestionDto),
      }),
    ),
    questions: (questionsByParent.get(questionKey(category._id, null)) ?? []).map(toQuestionDto),
  }));
}

export function assembleTree(docs: SurveyTreeDocs): SurveyTreeDto {
  const categories = assembleCategories(docs);
  return {
    survey: toSurveyDto(docs.survey),
    categories,
    issues: docs.survey.status === 'DRAFT' ? publishIssues(categories) : [],
  };
}

// --- reads (exported for other modules) ------------------------------------

/** `GET /surveys/:id`: the full tree of one version; 404 when unknown. */
export async function getSurveyTree(surveyId: string): Promise<SurveyTreeDto> {
  return assembleTree(await loadSurveyTreeDocs(surveyId));
}

/** The one PUBLISHED version of a type, or null when nothing is published yet. */
export async function getPublishedSurvey(type: SurveyType): Promise<SurveyDto | null> {
  const doc = await SurveyModel.findOne({ code: type, status: 'PUBLISHED' }).sort({ version: -1 }).lean<SurveyDoc>();
  return doc ? toSurveyDto(doc) : null;
}

/** What a cycle pins at publish: the published version id per type, absent when a type has none. */
export async function latestPublishedVersionIds(): Promise<{ DOMESTIC?: string; INTERNATIONAL?: string }> {
  const docs = await SurveyModel.find({ status: 'PUBLISHED' }).sort({ version: -1 }).lean<SurveyDoc[]>();
  const ids: { DOMESTIC?: string; INTERNATIONAL?: string } = {};
  for (const doc of docs) {
    ids[doc.code] ??= idString(doc._id);
  }
  return ids;
}

/**
 * The form one stakeholder type answers: active questions aimed at that type,
 * in order, inside their category / subcategory; groups left empty by the
 * filter are dropped. `questionCount` is the progress denominator.
 */
export async function getFormForStakeholder(surveyId: string, stakeholderType: StakeholderType): Promise<FormDto> {
  const docs = await loadSurveyTreeDocs(surveyId);
  const asked = (questions: readonly QuestionDto[]) =>
    questions.filter((question) => question.active && question.stakeholderTypes.includes(stakeholderType)).map(toFormQuestion);
  const categories = assembleCategories(docs)
    .map((category): FormCategoryDto => {
      const subcategories = category.subcategories
        .map((sub): FormSubcategoryDto => ({ id: sub.id, code: sub.code, name: sub.name, order: sub.order, questions: asked(sub.questions) }))
        .filter((sub) => sub.questions.length > 0);
      return {
        id: category.id,
        code: category.code,
        name: category.name,
        order: category.order,
        weightPct: category.weightPct,
        questions: asked(category.questions),
        subcategories,
      };
    })
    .filter((category) => category.questions.length > 0 || category.subcategories.length > 0);
  const questionCount = categories.reduce(
    (sum, category) => sum + category.questions.length + category.subcategories.reduce((inner, sub) => inner + sub.questions.length, 0),
    0,
  );
  const { survey } = docs;
  return {
    survey: { id: idString(survey._id), code: survey.code, name: survey.name, version: survey.version, status: survey.status },
    stakeholderType,
    scale: RATING_SCALE.map((step) => ({ ...step })),
    questionCount,
    categories,
  };
}

/** `GET /surveys`: both types, versions newest first, with question counts. */
export async function listSurveys(): Promise<SurveyListDto> {
  const [docs, counts] = await Promise.all([
    SurveyModel.find({}).sort({ code: 1, version: -1 }).lean<SurveyDoc[]>(),
    QuestionModel.aggregate<{ _id: Types.ObjectId; count: number }>([{ $group: { _id: '$surveyId', count: { $sum: 1 } } }]),
  ]);
  const countBySurvey = new Map(counts.map((row) => [idString(row._id), row.count]));
  return SURVEY_TYPES.map((code) => {
    const versions = docs
      .filter((doc) => doc.code === code)
      .map((doc) => ({ ...toSurveyDto(doc), questionCount: countBySurvey.get(idString(doc._id)) ?? 0 }));
    return {
      code,
      name: versions[0]?.name ?? DEFAULT_SURVEY_NAMES[code],
      publishedVersionId: versions.find((version) => version.status === 'PUBLISHED')?.id ?? null,
      draftVersionId: versions.find((version) => version.status === 'DRAFT')?.id ?? null,
      versions,
    };
  });
}

// --- creating whole versions -----------------------------------------------

export interface QuestionDefinition {
  code: string;
  text: string;
  help: string | null;
  order: number;
  weightPct: number | null;
  mandatory: boolean;
  commentMode: CommentMode;
  stakeholderTypes: StakeholderType[];
  followUp: FollowUp | null;
  active: boolean;
}

export interface SubcategoryDefinition {
  code: string;
  name: string;
  order: number;
  questions: QuestionDefinition[];
}

export interface CategoryDefinition {
  code: string;
  name: string;
  order: number;
  weightPct: number | null;
  subcategories: SubcategoryDefinition[];
  questions: QuestionDefinition[];
}

/** A whole version as plain data: what the seed builds from the YAML bank and what a deep copy produces. */
export interface SurveyDefinition {
  code: SurveyType;
  name: string;
  version: number;
  status: SurveyStatus;
  publishedAt?: Date | null;
  publishedBy?: Types.ObjectId | null;
  categories: CategoryDefinition[];
}

function questionDefinitionOf(doc: QuestionDoc): QuestionDefinition {
  return {
    code: doc.code,
    text: doc.text,
    help: doc.help,
    order: doc.order,
    weightPct: doc.weightPct,
    mandatory: doc.mandatory,
    commentMode: doc.commentMode,
    stakeholderTypes: [...doc.stakeholderTypes],
    followUp: doc.followUp ? { prompt: doc.followUp.prompt, options: [...doc.followUp.options] } : null,
    active: doc.active,
  };
}

/** The tree of a version as a definition, so it can be inserted again under new ids. */
export function definitionOf(docs: SurveyTreeDocs): CategoryDefinition[] {
  const subsByCategory = groupBy(docs.subcategories, (sub) => idString(sub.categoryId));
  const questionsByParent = groupBy(docs.questions, (question) => questionKey(question.categoryId, question.subcategoryId));
  return docs.categories.map((category) => ({
    code: category.code,
    name: category.name,
    order: category.order,
    weightPct: category.weightPct,
    subcategories: (subsByCategory.get(idString(category._id)) ?? []).map((sub) => ({
      code: sub.code,
      name: sub.name,
      order: sub.order,
      questions: (questionsByParent.get(questionKey(category._id, sub._id)) ?? []).map(questionDefinitionOf),
    })),
    questions: (questionsByParent.get(questionKey(category._id, null)) ?? []).map(questionDefinitionOf),
  }));
}

/** Inserts a version and every node of it; the caller supplies the transaction when atomicity matters. */
export async function createSurveyFromDefinition(definition: SurveyDefinition, session?: ClientSession): Promise<SurveyDoc> {
  const surveyId = newId();
  const categories: Omit<CategoryDoc, 'createdAt' | 'updatedAt'>[] = [];
  const subcategories: Omit<SubcategoryDoc, 'createdAt' | 'updatedAt'>[] = [];
  const questions: Omit<QuestionDoc, 'createdAt' | 'updatedAt'>[] = [];

  const addQuestion = (categoryId: Types.ObjectId, subcategoryId: Types.ObjectId | null, question: QuestionDefinition): void => {
    questions.push({ _id: newId(), surveyId, categoryId, subcategoryId, ...question });
  };
  for (const category of definition.categories) {
    const categoryId = newId();
    categories.push({ _id: categoryId, surveyId, code: category.code, name: category.name, order: category.order, weightPct: category.weightPct });
    for (const question of category.questions) addQuestion(categoryId, null, question);
    for (const sub of category.subcategories) {
      const subcategoryId = newId();
      subcategories.push({ _id: subcategoryId, surveyId, categoryId, code: sub.code, name: sub.name, order: sub.order });
      for (const question of sub.questions) addQuestion(categoryId, subcategoryId, question);
    }
  }

  const options = session ? { session } : {};
  const [created] = await SurveyModel.create(
    [
      {
        _id: surveyId,
        code: definition.code,
        name: definition.name,
        version: definition.version,
        status: definition.status,
        publishedAt: definition.publishedAt ?? null,
        publishedBy: definition.publishedBy ?? null,
      },
    ],
    options,
  );
  if (!created) throw new Error('Survey insert returned nothing');
  if (categories.length > 0) await CategoryModel.insertMany(categories, options);
  if (subcategories.length > 0) await SubcategoryModel.insertMany(subcategories, options);
  if (questions.length > 0) await QuestionModel.insertMany(questions, options);
  return created.toObject();
}

/**
 * `POST /surveys/:id/versions`: the next version of the type as a DRAFT, a
 * deep copy of the type's latest version. `:id` may also be the type code,
 * which starts an empty v1 when the type has no version yet. One draft per
 * type at a time (409 otherwise).
 */
export async function createSurveyVersion(ctx: RequestContext, ref: string, input: CreateVersionInput): Promise<SurveyTreeDto> {
  const type = isSurveyType(ref) ? ref : (await requireSurvey(ref)).code;
  const [latest, draft] = await Promise.all([
    findLatestSurvey(type),
    SurveyModel.findOne({ code: type, status: 'DRAFT' }).lean<SurveyDoc>(),
  ]);
  if (draft) {
    throw new AppError('CONFLICT', `${type} already has a draft (version ${draft.version}); edit or publish it first`, {
      draftId: idString(draft._id),
    });
  }
  const categories = latest ? definitionOf(await loadSurveyTreeDocs(idString(latest._id))) : [];
  const created = await withTransaction((session) =>
    createSurveyFromDefinition(
      {
        code: type,
        name: input.name ?? latest?.name ?? DEFAULT_SURVEY_NAMES[type],
        version: (latest?.version ?? 0) + 1,
        status: 'DRAFT',
        categories,
      },
      session,
    ),
  );
  return getSurveyTree(idString(created._id));
}

/**
 * `POST /surveys/:id/publish`: a DRAFT with no publish issues becomes
 * PUBLISHED (immutable from now on) and the type's previously published
 * version is RETIRED. Audited as `survey.published`.
 */
export async function publishSurvey(ctx: RequestContext, surveyId: string): Promise<SurveyDto> {
  const docs = await loadSurveyTreeDocs(surveyId);
  if (docs.survey.status !== 'DRAFT') {
    throw new AppError('PRECONDITION_FAILED', `Survey version ${docs.survey.version} is ${docs.survey.status.toLowerCase()}; only a draft can be published`, {
      surveyId,
      status: docs.survey.status,
    });
  }
  const issues = publishIssues(assembleCategories(docs));
  if (issues.length > 0) throw new AppError('PRECONDITION_FAILED', 'Survey is not ready to publish', { issues });

  const retired = await withTransaction(async (session) => {
    const previous = await SurveyModel.find({ code: docs.survey.code, status: 'PUBLISHED' }, { _id: 1, version: 1 }, { session }).lean<
      Pick<SurveyDoc, '_id' | 'version'>[]
    >();
    await SurveyModel.updateMany({ code: docs.survey.code, status: 'PUBLISHED' }, { $set: { status: 'RETIRED' } }, { session });
    const result = await SurveyModel.updateOne(
      { _id: docs.survey._id, status: 'DRAFT' },
      { $set: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: toId(ctx.user.id) } },
      { session },
    );
    if (result.matchedCount === 0) throw new AppError('PRECONDITION_FAILED', 'Survey was published concurrently', { surveyId });
    return previous.map((doc) => ({ id: idString(doc._id), version: doc.version }));
  });

  const after = toSurveyDto(await requireSurvey(surveyId));
  await audit(ctx, {
    action: 'survey.published',
    entity: 'survey',
    entityId: surveyId,
    before: { status: 'DRAFT', version: after.version },
    after: { ...after, retired, questionCount: docs.questions.length },
  });
  return after;
}
