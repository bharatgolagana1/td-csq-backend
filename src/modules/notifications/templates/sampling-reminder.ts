import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

/** REQUIREMENTS §19: "Sampling closes in 3 days. Minimum required participants: 50. Currently selected: 37." */
export interface SamplingReminderVars {
  adminName: string;
  operatorName: string;
  cycleName: string;
  closesInDays: number;
  /** Formatted wall-clock string in `tz`. */
  samplingEnd: string;
  tz: string;
  required: number;
  selected: number;
}

export const samplingReminder: Template<SamplingReminderVars> = {
  render(vars, common) {
    const days = vars.closesInDays === 1 ? '1 day' : `${vars.closesInDays} days`;
    const subject = `Sampling closes in ${days} · ${vars.selected} / ${vars.required} selected · ${vars.cycleName}`;
    const lines = [
      `Dear ${vars.adminName},`,
      `Sampling for "${vars.cycleName}" closes in ${days}, on ${vars.samplingEnd} (${vars.tz}).`,
      `Minimum required participants: ${vars.required}. Currently selected for ${vars.operatorName}: ${vars.selected}.`,
      'Please complete your selection and lock the sample before the window closes; reminders stop once the sample is locked.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nSign in: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Open CSQ')}`, common.brandName),
    };
  },
};
