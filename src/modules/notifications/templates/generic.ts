import { layout, link, paragraphs } from './html.js';
import type { Template } from './types.js';

/** Free-form message for one-off operational mail; prefer a named template for anything recurring. */
export interface GenericVars {
  subject: string;
  paragraphs: string[];
  linkUrl?: string;
  linkLabel?: string;
}

export const generic: Template<GenericVars> = {
  render(vars, common) {
    const linkText = vars.linkUrl ? `\n\n${vars.linkLabel ?? 'Open'}: ${vars.linkUrl}` : '';
    const linkHtml = vars.linkUrl ? `\n${link(vars.linkUrl, vars.linkLabel ?? 'Open')}` : '';
    return {
      subject: vars.subject,
      text: `${vars.paragraphs.join('\n\n')}${linkText}\n`,
      html: layout(vars.subject, `${paragraphs(vars.paragraphs)}${linkHtml}`, common.brandName),
    };
  },
};
