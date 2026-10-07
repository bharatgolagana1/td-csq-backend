import { accountInvited } from './account-invited.js';
import { assessmentInvitation } from './assessment-invitation.js';
import { assessmentOtp } from './assessment-otp.js';
import { assessmentReminder } from './assessment-reminder.js';
import { assessmentThankYou } from './assessment-thank-you.js';
import { cyclePublished } from './cycle-published.js';
import { generic } from './generic.js';
import { registrationApproved } from './registration-approved.js';
import { registrationReceived } from './registration-received.js';
import { registrationRejected } from './registration-rejected.js';
import { sampleLocked } from './sample-locked.js';
import { sampleUnlocked } from './sample-unlocked.js';
import { samplingClosed } from './sampling-closed.js';
import { samplingReminder } from './sampling-reminder.js';
import type { RenderedMail, Template, TemplateCommon } from './types.js';

/**
 * Every e-mail template, one file each. To add one: create
 * `templates/<name>.ts` exporting a `Template<Vars>`, register it here, and
 * `send({ template: '<name>', vars })` becomes type-checked.
 */
export const templates = {
  'account-invited': accountInvited,
  'registration-received': registrationReceived,
  'registration-approved': registrationApproved,
  'registration-rejected': registrationRejected,
  'sample-locked': sampleLocked,
  'sample-unlocked': sampleUnlocked,
  'cycle-published': cyclePublished,
  'sampling-reminder': samplingReminder,
  'sampling-closed': samplingClosed,
  'assessment-invitation': assessmentInvitation,
  'assessment-otp': assessmentOtp,
  'assessment-reminder': assessmentReminder,
  'assessment-thank-you': assessmentThankYou,
  generic,
} satisfies Record<string, Template<never>>;

export type TemplateName = keyof typeof templates;

export type TemplateVars<T extends TemplateName> = (typeof templates)[T] extends Template<infer V> ? V : never;

export const TEMPLATE_NAMES = Object.keys(templates) as TemplateName[];

export function renderTemplate<T extends TemplateName>(name: T, vars: TemplateVars<T>, common: TemplateCommon): RenderedMail {
  const template = templates[name] as Template<TemplateVars<T>>;
  return template.render(vars, common);
}

export type { RenderedMail, TemplateCommon } from './types.js';
