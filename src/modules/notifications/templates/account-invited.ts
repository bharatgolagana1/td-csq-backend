import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface AccountInvitedVars {
  name: string;
  orgName: string;
  roleName: string;
  invitedBy: string;
}

export const accountInvited: Template<AccountInvitedVars> = {
  render(vars, common) {
    const subject = `You have been invited to ${common.brandName} CSQ`;
    const lines = [
      `Dear ${vars.name},`,
      `${vars.invitedBy} has added you to ${vars.orgName} on the ${common.brandName} Cargo Service Quality platform as ${vars.roleName}.`,
      'Sign in with your e-mail address to get started. If you do not yet have a password, use "Forgot password" on the sign-in page to set one.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nSign in: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Sign in to CSQ')}`, common.brandName),
    };
  },
};
