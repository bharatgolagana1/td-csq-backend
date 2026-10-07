import { layout, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface AssessmentThankYouVars {
  contactName: string;
  operatorName: string;
  cycleName: string;
}

/** Sent once the participant submits; the invitation is closed and reminders stop. */
export const assessmentThankYou: Template<AssessmentThankYouVars> = {
  render(vars, common) {
    const subject = `Thank you for assessing ${vars.operatorName}`;
    const lines = [
      `Dear ${vars.contactName},`,
      `Thank you for completing your assessment of ${vars.operatorName} for the ${common.brandName} survey "${vars.cycleName}".`,
      'Your responses have been recorded and cannot be changed. They will be combined with other assessments and reported in aggregate only.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n`,
      html: layout(subject, paragraphs(lines), common.brandName),
    };
  },
};
