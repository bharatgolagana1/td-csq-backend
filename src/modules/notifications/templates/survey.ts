/**
 * "CSQ 2026 H2 · Domestic survey": how the participant e-mails name the
 * cycle and the survey, so a customer invited to both surveys of a cycle can
 * tell the two invitations (and their reminders) apart.
 */
export function surveyHeading(cycleName: string, surveyType: string): string {
  return `${cycleName} · ${surveyType} survey`;
}
