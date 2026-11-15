import { escapeHtml, layout, paragraphs } from './html.js';
import type { Template } from './types.js';

export interface AssessmentOtpVars {
  contactName: string;
  operatorName: string;
  /** "Domestic" or "International": the code opens that survey's link only. */
  surveyType: string;
  otp: string;
  expiresInMinutes: number;
}

/** REQUIREMENTS §16: OTP / passwordless access to the assessment link. */
export const assessmentOtp: Template<AssessmentOtpVars> = {
  render(vars, common) {
    const subject = `${vars.otp} is your ${common.brandName} CSQ code · ${vars.surveyType} survey`;
    const lines = [
      `Dear ${vars.contactName},`,
      `Use this code to open your assessment of the ${vars.surveyType.toLowerCase()} cargo services of ${vars.operatorName}. It is valid for ${vars.expiresInMinutes} minutes.`,
    ];
    const footer = ['If you did not request this code you can ignore this e-mail.'];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nYour code: ${vars.otp}\n\n${footer.join('\n\n')}\n`,
      html: layout(
        subject,
        `${paragraphs(lines)}\n<p style="font-size: 28px; letter-spacing: 6px; font-weight: 700;">${escapeHtml(vars.otp)}</p>\n${paragraphs(footer)}`,
        common.brandName,
      ),
    };
  },
};
