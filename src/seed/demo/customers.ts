// Each operator's FF / CB directory, generated from a stable stream and
// created through the customers service (normalised fields, one e-mail per
// operator, audit rows). A few customers are deactivated afterwards so the
// directory shows both statuses.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { CustomerModel } from '../../modules/customers/customers.model.js';
import { createCustomer, deactivateCustomer } from '../../modules/customers/customers.service.js';

import { CB_PREFIX, CB_SUFFIX, CUSTOMER_TAGS, FF_PREFIX, FF_SUFFIX, FIRST_NAMES, LAST_NAMES } from './names.js';
import type { DemoOperator, OperatorSpec } from './operators.js';
import type { Rng } from './prng.js';
import { countDemoByPrefix, demoKey, findDemoId, tagDemo } from './runtime.js';

export type CustomerType = 'FF' | 'CB';
export type CustomerSurveyType = 'DOMESTIC' | 'INTERNATIONAL' | 'BOTH';

export interface CustomerPlan {
  index: number;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  type: CustomerType;
  surveyType: CustomerSurveyType;
  tags: string[];
  inactive: boolean;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}

function companyName(type: CustomerType, rng: Rng): string {
  return type === 'FF' ? `${rng.pick(FF_PREFIX)} ${rng.pick(FF_SUFFIX)}` : `${rng.pick(CB_PREFIX)} ${rng.pick(CB_SUFFIX)}`;
}

function tagsFor(type: CustomerType, rng: Rng): string[] {
  const count = rng.weighted([55, 35, 10]);
  const pool = type === 'FF' ? CUSTOMER_TAGS : CUSTOMER_TAGS.filter((tag) => tag !== 'perishables');
  return rng.sample(pool, count);
}

/** A `+91` mobile the customers normaliser accepts as E.164. */
function phoneFor(rng: Rng): string {
  let digits: string = rng.pick(['6', '7', '8', '9']);
  for (let i = 0; i < 9; i += 1) digits += String(rng.int(0, 9));
  return `+91${digits}`;
}

/**
 * The directory of one operator. Metros mix the three survey types; a
 * domestic-only operator keeps international-only customers to at most two
 * and deactivates two, so at least `customers − 4` entries stay eligible for
 * a domestic cycle (the sample minimum is 30).
 */
export function planCustomers(spec: OperatorSpec, rng: Rng): CustomerPlan[] {
  const metro = spec.international;
  const names = new Set<string>();
  const plans: CustomerPlan[] = [];
  let internationalOnly = 0;
  for (let index = 1; index <= spec.customers; index += 1) {
    const type: CustomerType = rng.chance(0.65) ? 'FF' : 'CB';
    let name = companyName(type, rng);
    for (let attempt = 0; names.has(name) && attempt < 20; attempt += 1) name = companyName(type, rng);
    if (names.has(name)) name = `${name} ${index}`;
    names.add(name);
    let surveyType: CustomerSurveyType = (['DOMESTIC', 'INTERNATIONAL', 'BOTH'] as const)[rng.weighted(metro ? [35, 25, 40] : [72, 3, 25])] ?? 'DOMESTIC';
    if (!metro && surveyType === 'INTERNATIONAL') {
      internationalOnly += 1;
      if (internationalOnly > 2) surveyType = 'DOMESTIC';
    }
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    plans.push({
      index,
      name,
      contactPerson: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${slugOf(name)}.example.in`,
      phone: phoneFor(rng),
      type,
      surveyType,
      tags: tagsFor(type, rng),
      inactive: false,
    });
  }
  const inactive = metro ? 4 : 2;
  for (const plan of rng.sample(plans, inactive)) plan.inactive = true;
  return plans;
}

export interface CustomersResult {
  planned: number;
  created: number;
}

export async function ensureCustomers(ctx: RequestContext, operator: DemoOperator, rng: Rng): Promise<CustomersResult> {
  const plans = planCustomers(operator.spec, rng.fork(`customers:${operator.spec.code}`));
  const prefix = demoKey('customer', `${operator.spec.code}:`);
  const result: CustomersResult = { planned: plans.length, created: 0 };
  if ((await countDemoByPrefix(CustomerModel, prefix)) === plans.length) return result;

  const acoId = idString(operator.org._id);
  for (const plan of plans) {
    const key = `${prefix}${plan.index}`;
    if ((await findDemoId(CustomerModel, key)) !== null) continue;
    const dto = await createCustomer(ctx, {
      acoId,
      name: plan.name,
      contactPerson: plan.contactPerson,
      email: plan.email,
      phone: plan.phone,
      type: plan.type,
      surveyType: plan.surveyType,
      tags: plan.tags,
    });
    await tagDemo(CustomerModel, dto.id, key);
    if (plan.inactive) await deactivateCustomer(ctx, dto.id);
    result.created += 1;
  }
  return result;
}
