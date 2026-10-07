import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

/** Sent when sampling closes to ACO admins of operators that did not lock a sample (ARCHITECTURE §7 "Cycle clock"). */
export interface SamplingClosedVars {
  adminName: string;
  operatorName: string;
  cycleName: string;
  /** Formatted wall-clock string in `tz`. */
  samplingEnd: string;
  tz: string;
  required: number;
  selected: number;
}

export const samplingClosed: Template<SamplingClosedVars> = {
  render(vars, common) {
    const subject = `Sampling closed without a locked sample · ${vars.cycleName}`;
    const lines = [
      `Dear ${vars.adminName},`,
      `The sampling window for "${vars.cycleName}" closed on ${vars.samplingEnd} (${vars.tz}) and ${vars.operatorName} has not locked its sample (${vars.selected} of ${vars.required} selected).`,
      `${common.brandName} has been informed and may extend the window. Please contact ${common.brandName} if you need more time.`,
    ];
    return {
      subject,
      text: `${lines.join('\n\n')}\n\nSign in: ${common.webUrl}\n`,
      html: layout(subject, `${paragraphs(lines)}\n${link(common.webUrl, 'Open CSQ')}`, common.brandName),
    };
  },
};
