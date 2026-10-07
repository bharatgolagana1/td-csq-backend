import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface SampleUnlockedVars {
  name: string;
  orgName: string;
  cycleName: string;
  cycleCode: string;
  reason: string;
  unlockedBy: string;
}

export const sampleUnlocked: Template<SampleUnlockedVars> = {
  render(vars, common) {
    const subject = `Sample unlocked for ${vars.cycleName}`;
    const lines = [
      `Dear ${vars.name},`,
      `${common.brandName} (${vars.unlockedBy}) has unlocked the participant sample of ${vars.orgName} for the assessment cycle ${vars.cycleName} (${vars.cycleCode}).`,
      `Reason: ${vars.reason}`,
      'Pending invitations have been withdrawn. Review the selection and lock the sample again before the sampling deadline.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nOpen CSQ: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Open CSQ')}`, common.brandName),
    };
  },
};
