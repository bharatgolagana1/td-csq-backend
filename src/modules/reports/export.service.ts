// `GET /reports/export?scope=`: the operator, airport or national report as
// CSV. The route is open to any signed-in user; the task of the chosen scope
// is asserted here, so the same confidentiality rules as the JSON reports apply.
import { assertTask } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';

import { airportReport } from './airport-report.service.js';
import { nationalReport } from './national-report.service.js';
import { operatorQuestions, operatorReport } from './operator-report.service.js';
import { csvFileName, toCsv, type CsvCell } from './reports.csv.js';
import { round2 } from './reports.figures.js';
import type { ExportQuery } from './reports.schemas.js';

export interface CsvExport {
  fileName: string;
  contentType: 'text/csv; charset=utf-8';
  csv: string;
}

const OPERATOR_COLUMNS = ['level', 'code', 'name', 'customer_mean', 'customer_n', 'self_mean', 'previous_mean', 'delta', 'suppressed', 'comments'] as const;
const AIRPORT_COLUMNS = ['level', 'code', 'name', 'mean', 'share_pct', 'covered_share_pct', 'market_share_applied', 'suppressed'] as const;
const NATIONAL_COLUMNS = ['section', 'code', 'name', 'airport', 'rating', 'n', 'rank', 'rank_of', 'suppressed'] as const;

type Row = Record<string, CsvCell>;

function requireId(value: string | undefined, name: string): string {
  if (value === undefined) throw new AppError('VALIDATION', `Query parameter "${name}" is required for this scope`, { in: 'query', name });
  return value;
}

async function operatorCsv(ctx: RequestContext, query: ExportQuery): Promise<CsvExport> {
  assertTask(ctx, 'reports.operator');
  const acoId = requireId(query.acoId, 'acoId');
  const [report, questions] = await Promise.all([operatorReport(ctx, acoId, query), operatorQuestions(ctx, acoId, query)]);
  const { current, previous } = report.comparison;
  const previousMean = previous?.customer ?? null;
  const rows: Row[] = [
    {
      level: 'OVERALL',
      code: 'OVERALL',
      name: 'Overall',
      customer_mean: report.overall.customer.mean,
      customer_n: report.overall.customer.n,
      self_mean: report.overall.self.mean,
      previous_mean: previousMean,
      delta: current.customer !== null && previousMean !== null ? round2(current.customer - previousMean) : null,
      suppressed: report.overall.suppressed ?? null,
      comments: null,
    },
  ];
  for (const category of report.categories) {
    rows.push(figuresRow('CATEGORY', category));
    for (const subcategory of category.subcategories) rows.push(figuresRow('SUBCATEGORY', subcategory));
  }
  for (const question of questions.questions) rows.push({ ...figuresRow('QUESTION', { ...question, name: question.text }), comments: question.comments });
  return {
    fileName: csvFileName('operator', report.operator.code, report.cycle.code, report.surveyType),
    contentType: 'text/csv; charset=utf-8',
    csv: toCsv(OPERATOR_COLUMNS, rows),
  };
}

interface Figures {
  code: string;
  name: string;
  customer: { mean: number | null; n: number };
  self: { mean: number | null };
  previous: number | null;
  delta: number | null;
  suppressed?: string | undefined;
}

function figuresRow(level: string, node: Figures): Row {
  return {
    level,
    code: node.code,
    name: node.name,
    customer_mean: node.customer.mean,
    customer_n: node.customer.n,
    self_mean: node.self.mean,
    previous_mean: node.previous,
    delta: node.delta,
    suppressed: node.suppressed ?? null,
    comments: null,
  };
}

async function airportCsv(ctx: RequestContext, query: ExportQuery): Promise<CsvExport> {
  assertTask(ctx, 'reports.airport');
  const report = await airportReport(ctx, requireId(query.airportId, 'airportId'), query);
  const rows: Row[] = [
    {
      level: 'OVERALL',
      code: 'OVERALL',
      name: 'Overall',
      mean: report.overall.mean,
      share_pct: null,
      covered_share_pct: report.overall.coveredSharePct,
      market_share_applied: report.overall.marketShareApplied,
      suppressed: null,
    },
    ...report.categories.map((category) => ({
      level: 'CATEGORY',
      code: category.code,
      name: category.name,
      mean: category.mean,
      share_pct: null,
      covered_share_pct: category.coveredSharePct,
      market_share_applied: category.marketShareApplied,
      suppressed: null,
    })),
    ...(report.operators ?? []).map((operator) => ({
      level: 'OPERATOR',
      code: operator.code,
      name: operator.name,
      mean: operator.mean,
      share_pct: operator.sharePct,
      covered_share_pct: null,
      market_share_applied: null,
      suppressed: operator.suppressed,
    })),
  ];
  return {
    fileName: csvFileName('airport', report.airport.iata, report.cycle.code, report.surveyType),
    contentType: 'text/csv; charset=utf-8',
    csv: toCsv(AIRPORT_COLUMNS, rows),
  };
}

async function nationalCsv(ctx: RequestContext, query: ExportQuery): Promise<CsvExport> {
  assertTask(ctx, 'reports.national');
  const report = await nationalReport(ctx, query);
  const rows: Row[] = [
    ...report.airports.map((airport) => ({
      section: 'AIRPORT',
      code: airport.iata,
      name: airport.name,
      airport: airport.iata,
      rating: airport.rating,
      n: null,
      rank: airport.rank,
      rank_of: airport.rankOf,
      suppressed: null,
    })),
    ...report.operators.map((operator) => ({
      section: 'OPERATOR',
      code: operator.code,
      name: operator.name,
      airport: operator.airport?.iata ?? null,
      rating: operator.rating,
      n: operator.n,
      rank: operator.rank,
      rank_of: operator.rankOf,
      suppressed: operator.suppressed ?? null,
    })),
    ...report.categories.map((category) => ({
      section: 'CATEGORY',
      code: category.code,
      name: category.name,
      airport: null,
      rating: category.mean,
      n: category.n,
      rank: null,
      rank_of: null,
      suppressed: null,
    })),
  ];
  return {
    fileName: csvFileName('national', report.cycle.code, report.surveyType),
    contentType: 'text/csv; charset=utf-8',
    csv: toCsv(NATIONAL_COLUMNS, rows),
  };
}

export async function exportReport(ctx: RequestContext, query: ExportQuery): Promise<CsvExport> {
  switch (query.scope) {
    case 'operator':
      return operatorCsv(ctx, query);
    case 'airport':
      return airportCsv(ctx, query);
    case 'national':
      return nationalCsv(ctx, query);
  }
}
