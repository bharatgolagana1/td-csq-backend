// The one place cycles reads the surveys module: which survey version is
// published per survey type, pinned onto the cycle at publish (ARCHITECTURE §5
// `cycles.surveyVersions`). Tests may replace the resolver instead of building
// survey trees.
import { latestPublishedVersionIds } from '../surveys/surveys.service.js';

import type { SurveyType } from './domain/types.js';

export type PublishedSurveyVersions = Partial<Record<SurveyType, string>>;
export type PublishedSurveyResolver = () => Promise<PublishedSurveyVersions>;

let resolver: PublishedSurveyResolver = latestPublishedVersionIds;

/** `{ DOMESTIC?, INTERNATIONAL? }` — the latest PUBLISHED survey version id per type. */
export function publishedSurveyVersions(): Promise<PublishedSurveyVersions> {
  return resolver();
}

/** Tests only: replace the lookup; `null` restores the surveys module's. */
export function overridePublishedSurveyResolver(next: PublishedSurveyResolver | null): void {
  resolver = next ?? latestPublishedVersionIds;
}
