import { layout, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface RegistrationRejectedVars {
  adminName: string;
  orgName: string;
  /** The reviewer's note; always present, a rejection is never silent. */
  note: string;
}

export const registrationRejected: Template<RegistrationRejectedVars> = {
  render(vars, common) {
    const subject = `Registration for ${vars.orgName} was not approved`;
    const lines = [
      `Dear ${vars.adminName},`,
      `${common.brandName} has reviewed the registration request for ${vars.orgName} and was unable to approve it.`,
      `Reason: ${vars.note}`,
      `If you believe this is a mistake or would like to apply again, please contact ${common.brandName}.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n`,
      html: layout(subject, paragraphs(lines), common.brandName),
    };
  },
};
