import { layout, paragraphs } from './html.js';
import { surveyHeading } from './survey.js';
import type { Template } from './types.js';

export interface AssessmentThankYouVars {
  contactName: string;
  operatorName: string;
  cycleName: string;
  /** "Domestic" or "International": which of a customer's invitations this closes. */
  surveyType: string;
}

/** Sent once the participant submits; the invitation is closed and reminders stop. */
export const assessmentThankYou: Template<AssessmentThankYouVars> = {
  render(vars, common) {
    const subject = `${surveyHeading(vars.cycleName, vars.surveyType)}: thank you for rating ${vars.operatorName}`;
    const lines = [
      `Dear ${vars.contactName},`,
      `Thank you for completing your assessment of the ${vars.surveyType.toLowerCase()} cargo services of ${vars.operatorName} for the ${common.brandName} survey "${vars.cycleName}".`,
      'Your responses have been recorded and cannot be changed. They will be combined with other assessments and reported in aggregate only.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n`,
      html: layout(subject, paragraphs(lines), common.brandName),
    };
  },
};
