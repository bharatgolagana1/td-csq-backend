import { route } from '../../core/http.js';

import { settingsPatch, settingsResponse } from './settings.schemas.js';
import { getSettings, updateSettings } from './settings.service.js';

export const settingsRoutes = [
  route({
    method: 'get',
    path: '/',
    policy: { kind: 'task', task: 'settings.view' },
    response: settingsResponse,
    handler: () => getSettings(),
  }),
  route({
    method: 'patch',
    path: '/',
    policy: { kind: 'task', task: 'settings.manage' },
    body: settingsPatch,
    response: settingsResponse,
    handler: ({ ctx, body }) => updateSettings(ctx, body),
  }),
];
