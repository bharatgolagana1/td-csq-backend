/** Values every template receives besides its own vars. */
export interface TemplateCommon {
  brandName: string;
  webUrl: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface Template<Vars> {
  render(vars: Vars, common: TemplateCommon): RenderedMail;
}
