import { z } from 'zod';

import { WEIGHTING_MODES } from './settings.model.js';

const reminderRule = z.object({
  count: z.number().int().min(0).max(100),
  everyDays: z.number().int().min(1).max(365),
});

export const settingsResponse = z.object({
  scoring: z.object({ minResponses: z.number(), weightingMode: z.enum(WEIGHTING_MODES) }),
  defaults: z.object({
    samplingDays: z.number(),
    assessmentDays: z.number(),
    reminders: z.object({ sampling: reminderRule, assessment: reminderRule }),
    tz: z.string(),
  }),
  branding: z.object({ orgName: z.string() }),
  revealAssessorIdentity: z.boolean(),
  rbacVersion: z.number(),
  updatedAt: z.string(),
});

export type SettingsDto = z.infer<typeof settingsResponse>;

/** PATCH body: any subset of the editable sections (rbacVersion is system-managed). */
export const settingsPatch = z
  .object({
    scoring: z
      .object({ minResponses: z.number().int().min(1).max(1000), weightingMode: z.enum(WEIGHTING_MODES) })
      .partial(),
    defaults: z
      .object({
        samplingDays: z.number().int().min(1).max(365),
        assessmentDays: z.number().int().min(1).max(365),
        reminders: z.object({ sampling: reminderRule, assessment: reminderRule }).partial(),
        tz: z.string().min(1).max(64),
      })
      .partial(),
    branding: z.object({ orgName: z.string().trim().min(1).max(200) }).partial(),
    revealAssessorIdentity: z.boolean(),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatch>;
