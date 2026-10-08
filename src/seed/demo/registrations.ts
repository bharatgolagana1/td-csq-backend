// The onboarding corner of the demo: one open link ACFI minted and has not
// handed out yet, and two registrations waiting for review, submitted
// through the public form on links of their own. One of them asks for a
// share at an airport whose shares already total 100, so the review screen
// has something to say.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { findAirportByIata } from '../../modules/airports/airports.service.js';
import { createLink } from '../../modules/onboarding/links.service.js';
import { OnboardingLinkModel } from '../../modules/onboarding/onboarding-links.model.js';
import type { RegistrationFormInput } from '../../modules/onboarding/onboarding.schemas.js';
import { RegistrationModel } from '../../modules/onboarding/registrations.model.js';
import { submitRegistration } from '../../modules/onboarding/registrations.service.js';

import { DEMO_REQUEST_ID, demoKey, findDemoId, tagDemo } from './runtime.js';

interface RegistrationSpec {
  key: string;
  iata: string;
  note: string;
  form: RegistrationFormInput;
}

const REGISTRATIONS: readonly RegistrationSpec[] = [
  {
    key: 'BLR-BAFT',
    iata: 'BLR',
    note: 'Demo: third operator applying at Bengaluru',
    form: {
      organisation: {
        name: 'Bengaluru Air Freight Terminals',
        legalName: 'Bengaluru Air Freight Terminals Private Limited',
        address: { line1: 'Cargo Village, Gate 3', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560300' },
        contact: { name: 'Operations Desk', email: 'ops@baft.example.in', phone: '+91 80 4000 1000' },
      },
      admin: { name: 'Lakshmi Pillai', email: 'lakshmi.pillai@baft.example.in', phone: '+91 98450 00001' },
      operations: { domestic: true, international: true },
      // Bengaluru's current shares already total 100: approving this as asked would make 125.
      marketSharePct: 25,
    },
  },
  {
    key: 'JAI-JCS',
    iata: 'JAI',
    note: 'Demo: first operator at Jaipur',
    form: {
      organisation: {
        name: 'Jaipur Cargo Services',
        legalName: 'Jaipur Cargo Services LLP',
        address: { line1: 'Air Cargo Complex', line2: null, city: 'Jaipur', state: 'Rajasthan', pincode: '302011' },
        contact: { name: 'Cargo Office', email: 'cargo@jaipurcargo.example.in', phone: '+91 141 272 0000' },
      },
      admin: { name: 'Gaurav Saxena', email: 'gaurav.saxena@jaipurcargo.example.in', phone: '+91 98290 00002' },
      operations: { domestic: true, international: false },
      marketSharePct: 100,
    },
  },
];

export interface OnboardingResult {
  /** The registration URL of the open link, only on the run that minted it (the token is never stored). */
  unusedLinkUrl: string | null;
  registrationsCreated: number;
}

async function airportId(iata: string): Promise<string> {
  const airport = await findAirportByIata(iata);
  if (!airport) throw new Error(`Airport ${iata} is not seeded`);
  return idString(airport._id);
}

export async function ensureOnboarding(ctx: RequestContext): Promise<OnboardingResult> {
  const result: OnboardingResult = { unusedLinkUrl: null, registrationsCreated: 0 };

  const openKey = demoKey('link', 'TRV-open');
  if ((await findDemoId(OnboardingLinkModel, openKey)) === null) {
    const link = await createLink(ctx, { orgType: 'ACO', airportId: await airportId('TRV'), expiresInDays: 14, note: 'Demo: operator onboarding at Thiruvananthapuram (unused)' });
    await tagDemo(OnboardingLinkModel, link.id, openKey);
    result.unusedLinkUrl = link.url;
  }

  for (const spec of REGISTRATIONS) {
    const key = demoKey('registration', spec.key);
    if ((await findDemoId(RegistrationModel, key)) !== null) continue;
    const link = await createLink(ctx, { orgType: 'ACO', airportId: await airportId(spec.iata), expiresInDays: 14, note: spec.note });
    await tagDemo(OnboardingLinkModel, link.id, demoKey('link', spec.key));
    const token = link.url.slice(link.url.lastIndexOf('/') + 1);
    const { registrationId } = await submitRegistration(token, spec.form, { ip: '127.0.0.1', requestId: DEMO_REQUEST_ID });
    await tagDemo(RegistrationModel, registrationId, key);
    result.registrationsCreated += 1;
  }
  return result;
}
