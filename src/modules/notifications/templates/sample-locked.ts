import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface SampleLockedVars {
  name: string;
  orgName: string;
  cycleName: string;
  cycleCode: string;
  selectedCount: number;
  required: number;
  lockedBy: string;
}

export const sampleLocked: Template<SampleLockedVars> = {
  render(vars, common) {
    const subject = `Sample locked for ${vars.cycleName}`;
    const lines = [
      `Dear ${vars.name},`,
      `The participant sample of ${vars.orgName} for the assessment cycle ${vars.cycleName} (${vars.cycleCode}) has been locked by ${vars.lockedBy}.`,
      `Participants selected: ${vars.selectedCount} (minimum required: ${vars.required}).`,
      'The selected freight forwarders and customs brokers will receive their assessment invitations when the assessment window opens. The sample can only be changed if ACFI unlocks it.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nOpen CSQ: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Open CSQ')}`, common.brandName),
    };
  },
};
