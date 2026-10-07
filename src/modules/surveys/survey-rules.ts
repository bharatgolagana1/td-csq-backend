// Pure rules over an assembled survey tree: what stops a DRAFT from being
// published. Used by the tree response (`issues`) and by publish itself.
import type { CategoryDto, FormQuestionDto, Issue, QuestionDto } from './surveys.schemas.js';

/** Weights must total 100 within this tolerance (the same tolerance market shares use). */
export const WEIGHT_TOLERANCE = 0.01;

interface Weighted {
  code: string;
  weightPct: number | null;
}

/**
 * Weights among siblings are all-or-none: either every sibling carries a
 * `weightPct` and they total 100, or none does (equal weights at scoring time).
 * Inactive questions are neither asked nor scored, so they do not take part.
 */
function siblingWeightIssues(path: string, what: string, siblings: readonly Weighted[]): Issue[] {
  const weighted = siblings.filter((node) => node.weightPct !== null);
  if (weighted.length === 0 || siblings.length === 0) return [];
  if (weighted.length < siblings.length) {
    const missing = siblings.filter((node) => node.weightPct === null).map((node) => node.code);
    return [{ path, message: `weightPct is set on some ${what} but not on ${missing.join(', ')}` }];
  }
  const total = weighted.reduce((sum, node) => sum + (node.weightPct ?? 0), 0);
  if (Math.abs(total - 100) > WEIGHT_TOLERANCE) {
    return [{ path, message: `${what} weights must total 100 (got ${Math.round(total * 100) / 100})` }];
  }
  return [];
}

function activeOnly(questions: readonly QuestionDto[]): QuestionDto[] {
  return questions.filter((question) => question.active);
}

export function weightIssues(categories: readonly CategoryDto[]): Issue[] {
  const issues = siblingWeightIssues('categories', 'categories', categories);
  for (const category of categories) {
    issues.push(...siblingWeightIssues(`categories.${category.code}.questions`, 'questions', activeOnly(category.questions)));
    for (const subcategory of category.subcategories) {
      issues.push(
        ...siblingWeightIssues(
          `categories.${category.code}.subcategories.${subcategory.code}.questions`,
          'questions',
          activeOnly(subcategory.questions),
        ),
      );
    }
  }
  return issues;
}

/** Everything that must hold before a DRAFT becomes PUBLISHED. */
export function publishIssues(categories: readonly CategoryDto[]): Issue[] {
  const issues: Issue[] = [];
  if (categories.length === 0) issues.push({ path: 'categories', message: 'A survey needs at least one category' });
  const active = categories.flatMap((category) => [
    ...activeOnly(category.questions),
    ...category.subcategories.flatMap((subcategory) => activeOnly(subcategory.questions)),
  ]);
  if (categories.length > 0 && active.length === 0) {
    issues.push({ path: 'questions', message: 'A survey needs at least one active question' });
  }
  return [...issues, ...weightIssues(categories)];
}

/** The rating scale every question uses (REQUIREMENTS: ACFI's labels); NA is offered alongside. */
export const RATING_SCALE: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Fair' },
  { value: 3, label: 'Good' },
  { value: 4, label: 'Very Good' },
  { value: 5, label: 'Excellent' },
];

export function toFormQuestion(question: QuestionDto): FormQuestionDto {
  return {
    id: question.id,
    categoryId: question.categoryId,
    subcategoryId: question.subcategoryId,
    code: question.code,
    text: question.text,
    help: question.help,
    order: question.order,
    weightPct: question.weightPct,
    mandatory: question.mandatory,
    commentMode: question.commentMode,
    followUp: question.followUp,
  };
}
