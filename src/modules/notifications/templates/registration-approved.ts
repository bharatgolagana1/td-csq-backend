import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface RegistrationApprovedVars {
  adminName: string;
  orgName: string;
  orgCode: string;
}

export const registrationApproved: Template<RegistrationApprovedVars> = {
  render(vars, common) {
    const subject = `${vars.orgName} has been approved on CSQ`;
    const lines = [
      `Dear ${vars.adminName},`,
      `${common.brandName} has approved the registration of ${vars.orgName} (code ${vars.orgCode}).`,
      'You can now sign in with your e-mail address. If you do not yet have a password, use "Forgot password" on the sign-in page to set one.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nSign in: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Sign in to CSQ')}`, common.brandName),
    };
  },
};
