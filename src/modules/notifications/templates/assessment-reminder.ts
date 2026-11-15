import { layout, link, paragraphs } from './html.js';
import { surveyHeading } from './survey.js';
import type { Template } from './types.js';

export interface AssessmentReminderVars {
  contactName: string;
  operatorName: string;
  cycleName: string;
  /** "Domestic" or "International", as in the invitation. */
  surveyType: string;
  assessmentEnd: string;
  url: string;
  /** 1-based position in the reminder schedule. */
  reminderNumber: number;
}

/** REQUIREMENTS §18: reminders to participants who have not submitted; they stop on submission. The subject names the survey, as the invitation's does. */
export const assessmentReminder: Template<AssessmentReminderVars> = {
  render(vars, common) {
    const subject = `${surveyHeading(vars.cycleName, vars.surveyType)}: reminder to rate ${vars.operatorName} by ${vars.assessmentEnd}`;
    const lines = [
      `Dear ${vars.contactName},`,
      `This is a reminder that your assessment of the ${vars.surveyType.toLowerCase()} cargo services of ${vars.operatorName} for the ${common.brandName} survey "${vars.cycleName}" is still open.`,
      `Please complete it before ${vars.assessmentEnd}. Anything you have already saved is waiting for you.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nContinue the assessment: ${vars.url}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(vars.url, 'Continue the assessment')}`, common.brandName),
    };
  },
};
