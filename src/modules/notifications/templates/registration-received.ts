import { layout, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface RegistrationReceivedVars {
  adminName: string;
  orgName: string;
  airportName: string;
}

export const registrationReceived: Template<RegistrationReceivedVars> = {
  render(vars, common) {
    const subject = `Registration received for ${vars.orgName}`;
    const lines = [
      `Dear ${vars.adminName},`,
      `We have received the registration request for ${vars.orgName} at ${vars.airportName}.`,
      `${common.brandName} will review it and let you know once your account has been approved.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n`,
      html: layout(subject, paragraphs(lines), common.brandName),
    };
  },
};
