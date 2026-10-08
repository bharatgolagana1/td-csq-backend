import { afterAll, describe, expect, it } from 'vitest';

import { createLinkSessions } from '../../../src/core/auth/link.js';
import { webAppUrl } from '../../../src/core/web-url.js';
import { configureInvitations } from '../../../src/modules/invitations/invitations.config.js';
import { invitationLink } from '../../../src/modules/invitations/invitations.service.js';

/* Every link the API e-mails is PUBLIC_WEB_URL + an app path. The single-host
   layout puts the app under a base path (https://dev.csq.aero/app), so the
   join must be clean whether or not the variable ends in a slash. */

const BASES = ['https://dev.csq.aero/app', 'https://dev.csq.aero/app/', 'https://dev.csq.aero/app//', ' https://dev.csq.aero/app/ '];

describe('webAppUrl', () => {
  it.each(BASES)('joins %j with a leading-slash path', (base) => {
    expect(webAppUrl(base, '/assess/t0k')).toBe('https://dev.csq.aero/app/assess/t0k');
  });

  it('accepts a path without a leading slash and a bare origin', () => {
    expect(webAppUrl('https://dev.csq.aero/app', 'register/t0k')).toBe('https://dev.csq.aero/app/register/t0k');
    expect(webAppUrl('http://localhost:5173', '/registrations/r1')).toBe('http://localhost:5173/registrations/r1');
    expect(webAppUrl('http://localhost:5173/', '/registrations/r1')).toBe('http://localhost:5173/registrations/r1');
  });

  it('returns the root itself for an empty path', () => {
    expect(webAppUrl('https://dev.csq.aero/app/', '')).toBe('https://dev.csq.aero/app');
    expect(webAppUrl('https://dev.csq.aero/app/', '/')).toBe('https://dev.csq.aero/app');
  });
});

describe('links built from PUBLIC_WEB_URL', () => {
  const links = createLinkSessions('unit-test-link-session-secret-0123456789');

  afterAll(() => {
    configureInvitations(null);
  });

  it.each(BASES)('invitation link under %j', (base) => {
    configureInvitations({ links, webUrl: base, revealOtp: false });
    expect(invitationLink('t0k')).toBe('https://dev.csq.aero/app/assess/t0k');
  });

  it('registration form and review links carry the base path', async () => {
    const previous = process.env['PUBLIC_WEB_URL'];
    process.env['PUBLIC_WEB_URL'] = 'https://dev.csq.aero/app/';
    try {
      // The module memoises PUBLIC_WEB_URL on first use; import it after setting the value.
      const urls = await import('../../../src/modules/onboarding/onboarding.urls.js');
      expect(urls.registrationFormUrl('t0k')).toBe('https://dev.csq.aero/app/register/t0k');
      expect(urls.registrationReviewUrl('reg1')).toBe('https://dev.csq.aero/app/registrations/reg1');
    } finally {
      if (previous === undefined) delete process.env['PUBLIC_WEB_URL'];
      else process.env['PUBLIC_WEB_URL'] = previous;
    }
  });
});
