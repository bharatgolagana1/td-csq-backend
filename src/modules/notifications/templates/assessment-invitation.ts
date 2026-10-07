import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface AssessmentInvitationVars {
  contactName: string;
  customerName: string;
  operatorName: string;
  airportName: string;
  cycleName: string;
  surveyType: string;
  assessmentStart: string;
  assessmentEnd: string;
  /** `${PUBLIC_WEB_URL}/assess/${token}` — the only place the raw token travels. */
  url: string;
}

/** REQUIREMENTS §15: assessment name, airport, ACO, window and the secure link; access is by OTP. */
export const assessmentInvitation: Template<AssessmentInvitationVars> = {
  render(vars, common) {
    const subject = `${vars.cycleName}: please rate ${vars.operatorName}`;
    const where = vars.airportName ? `${vars.operatorName} at ${vars.airportName}` : vars.operatorName;
    const lines = [
      `Dear ${vars.contactName},`,
      `${vars.customerName} has been selected to assess the ${vars.surveyType.toLowerCase()} cargo services of ${where} in the ${common.brandName} Cargo Service Quality survey "${vars.cycleName}".`,
      `The assessment is open from ${vars.assessmentStart} until ${vars.assessmentEnd}. It takes about ten minutes; you can save and continue later.`,
      'Open your personal link below. We will e-mail you a one-time code to confirm it is you; no registration or password is needed.',
      'Your answers are confidential: the operator sees aggregated results only.',
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nStart the assessment: ${vars.url}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(vars.url, 'Start the assessment')}`, common.brandName),
    };
  },
};
