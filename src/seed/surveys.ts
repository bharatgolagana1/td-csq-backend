// The Phase 1 ACFI surveys: one PUBLISHED v1 per type (DOMESTIC 23 questions,
// INTERNATIONAL 27), built from the vendored YAML bank. Idempotent: a type
// that already has any version is left exactly as it is, so running the seed
// twice changes nothing and later edits (new versions) are never undone.
import { withTransaction } from '../core/db.js';
import { idString } from '../core/ids.js';
import { QuestionModel } from '../modules/surveys/questions.model.js';
import { bankQuestionsFor, loadSurveyBank, type BankHead, type BankQuestionForType } from '../modules/surveys/surveys.bank.js';
import { SURVEY_TYPES, type SurveyType } from '../modules/surveys/surveys.model.js';
import {
  createSurveyFromDefinition,
  DEFAULT_SURVEY_NAMES,
  findLatestSurvey,
  type CategoryDefinition,
  type QuestionDefinition,
} from '../modules/surveys/surveys.service.js';

/** Asked when a question is rated Fair or Poor (ARCHITECTURE §7 form rules). */
const FOLLOW_UP_PROMPT = 'What specifically went wrong?';

/**
 * Follow-up options per head. PLACEHOLDERS: ACFI has not supplied these; they
 * are generic reasons an assessor could pick under each head. Edit the lists
 * below (or the published survey's next draft) before the first live cycle.
 */
const FOLLOW_UP_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  INFRA: [
    'Not enough storage or handling space',
    'Equipment unavailable or out of order',
    'Facilities poorly maintained',
    'Long waiting or processing time',
    'Other',
  ],
  SEC: [
    'Security staff absent or insufficient',
    'Entry pass or access control slow',
    'CCTV or fire equipment not working',
    'Signage missing or unclear',
    'Other',
  ],
  PROC: [
    'IT system down or slow',
    'Slot or token system not followed',
    'Procedures unclear or not displayed',
    'Not enough staff for the process',
    'Other',
  ],
  TRADE: [
    'No response to grievances',
    'Agency or bank not available on site',
    'Incidents not investigated or reported',
    'Unhelpful attitude of personnel',
    'Other',
  ],
};

/** Used for a head the table above does not know (a head added to heads.yaml later). */
const GENERIC_FOLLOW_UP_OPTIONS: readonly string[] = ['Service unavailable', 'Long delay', 'Poor quality', 'Staff unhelpful', 'Other'];

function questionDefinition(question: BankQuestionForType, order: number): QuestionDefinition {
  return {
    code: question.code,
    text: question.text,
    help: question.help,
    order,
    weightPct: null,
    mandatory: true,
    commentMode: 'REQUIRED_ON_LOW',
    stakeholderTypes: ['FF', 'CB'],
    followUp: { prompt: FOLLOW_UP_PROMPT, options: [...(FOLLOW_UP_OPTIONS[question.categoryCode] ?? GENERIC_FOLLOW_UP_OPTIONS)] },
    active: true,
  };
}

/** Heads become categories in `displayOrder`; the questions of each head keep their file order. */
export function phase1Categories(heads: readonly BankHead[], questions: readonly BankQuestionForType[]): CategoryDefinition[] {
  return heads.map((head) => ({
    code: head.code,
    name: head.name,
    order: head.displayOrder,
    weightPct: null,
    subcategories: [],
    questions: questions.filter((question) => question.categoryCode === head.code).map((question, index) => questionDefinition(question, index + 1)),
  }));
}

export interface SeedSurveyResult {
  id: string;
  version: number;
  status: string;
  created: boolean;
  questions: number;
}

export type SeedSurveysResult = Record<SurveyType, SeedSurveyResult>;

export async function seedSurveys(): Promise<SeedSurveysResult> {
  const bank = await loadSurveyBank();
  const results: Partial<SeedSurveysResult> = {};
  for (const type of SURVEY_TYPES) {
    const existing = await findLatestSurvey(type);
    if (existing) {
      results[type] = {
        id: idString(existing._id),
        version: existing.version,
        status: existing.status,
        created: false,
        questions: await QuestionModel.countDocuments({ surveyId: existing._id }),
      };
      continue;
    }
    const categories = phase1Categories(bank.heads, bankQuestionsFor(bank, type));
    const created = await withTransaction((session) =>
      createSurveyFromDefinition(
        { code: type, name: DEFAULT_SURVEY_NAMES[type], version: 1, status: 'PUBLISHED', publishedAt: new Date(), categories },
        session,
      ),
    );
    results[type] = {
      id: idString(created._id),
      version: 1,
      status: created.status,
      created: true,
      questions: categories.reduce((sum, category) => sum + category.questions.length, 0),
    };
  }
  return results as SeedSurveysResult;
}

export function describeSeededSurvey(type: SurveyType, result: SeedSurveyResult): string {
  return `${type} v${result.version} ${result.status} (${result.created ? 'created' : 'kept'}, ${result.questions} questions)`;
}
