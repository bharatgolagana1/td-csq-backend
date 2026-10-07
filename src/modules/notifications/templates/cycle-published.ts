import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

/**
 * "Commencement of assessment cycle" to every ACO admin of a participating
 * operator (REQUIREMENTS §12): name, windows and the minimum sample size.
 * Also reused when the clock opens sampling (`samplingOpenNow: true`).
 */
export interface CyclePublishedVars {
  adminName: string;
  operatorName: string;
  cycleName: string;
  cycleCode: string;
  /** Formatted wall-clock strings in `tz`. */
  samplingStart: string;
  samplingEnd: string;
  assessmentStart: string;
  assessmentEnd: string;
  tz: string;
  requiredSampleSize: number;
  /** 'Domestic', 'International' or 'Domestic and International'. */
  surveyTypes: string;
  samplingOpenNow: boolean;
}

export const cyclePublished: Template<CyclePublishedVars> = {
  render(vars, common) {
    const subject = vars.samplingOpenNow
      ? `Sampling is open: ${vars.cycleName}`
      : `Commencement of assessment cycle: ${vars.cycleName}`;
    const lines = [
      `Dear ${vars.adminName},`,
      vars.samplingOpenNow
        ? `Sampling for the ${vars.surveyTypes} Cargo Service Quality assessment "${vars.cycleName}" (${vars.cycleCode}) is now open for ${vars.operatorName}.`
        : `${common.brandName} has published the ${vars.surveyTypes} Cargo Service Quality assessment "${vars.cycleName}" (${vars.cycleCode}). ${vars.operatorName} is a participating operator.`,
      `Sampling window: ${vars.samplingStart} to ${vars.samplingEnd} (${vars.tz}).`,
      `Assessment window: ${vars.assessmentStart} to ${vars.assessmentEnd} (${vars.tz}).`,
      `Minimum sample size: ${vars.requiredSampleSize} freight forwarders / customs brokers. Please select and lock your sample before the sampling window closes.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nSign in: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Open CSQ')}`, common.brandName),
    };
  },
};
