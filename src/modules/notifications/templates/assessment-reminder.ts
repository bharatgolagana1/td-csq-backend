import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface AssessmentReminderVars {
  contactName: string;
  operatorName: string;
  cycleName: string;
  assessmentEnd: string;
  url: string;
  /** 1-based position in the reminder schedule. */
  reminderNumber: number;
}

/** REQUIREMENTS §18: reminders to participants who have not submitted; they stop on submission. */
export const assessmentReminder: Template<AssessmentReminderVars> = {
  render(vars, common) {
    const subject = `Reminder: your ${vars.operatorName} assessment closes ${vars.assessmentEnd}`;
    const lines = [
      `Dear ${vars.contactName},`,
      `This is a reminder that your assessment of ${vars.operatorName} for the ${common.brandName} survey "${vars.cycleName}" is still open.`,
      `Please complete it before ${vars.assessmentEnd}. Anything you have already saved is waiting for you.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nContinue the assessment: ${vars.url}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(vars.url, 'Continue the assessment')}`, common.brandName),
    };
  },
};
