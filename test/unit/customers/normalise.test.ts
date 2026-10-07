import { describe, expect, it } from 'vitest';

import {
  normaliseContactPerson,
  normaliseCustomerType,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  normaliseSurveyType,
  normaliseTags,
  type Normalised,
} from '../../../src/modules/customers/domain/normalise.js';

const ok = <T>(value: T) => ({ ok: true, value });
const failure = (result: Normalised<unknown>): string => (result.ok ? '' : result.message);

describe('normalisePhone', () => {
  it('turns Indian mobiles into +91 E.164', () => {
    expect(normalisePhone('9876543210')).toEqual(ok('+919876543210'));
    expect(normalisePhone(' 98765 43210 ')).toEqual(ok('+919876543210'));
    expect(normalisePhone('098765-43210')).toEqual(ok('+919876543210'));
    expect(normalisePhone('919876543210')).toEqual(ok('+919876543210'));
    expect(normalisePhone('+91 98765 43210')).toEqual(ok('+919876543210'));
    expect(normalisePhone('+91-(98765)-43210')).toEqual(ok('+919876543210'));
    expect(normalisePhone('0091 9876543210')).toEqual(ok('+919876543210'));
  });

  it('keeps international numbers with a leading +', () => {
    expect(normalisePhone('+44 20 7946 0958')).toEqual(ok('+442079460958'));
    expect(normalisePhone('+1 (212) 555-0100')).toEqual(ok('+12125550100'));
    expect(normalisePhone('+971.4.123.4567')).toEqual(ok('+97141234567'));
  });

  it('rejects what it cannot read', () => {
    expect(normalisePhone('')).toMatchObject({ ok: false, message: 'Phone is required' });
    expect(normalisePhone('12345').ok).toBe(false);
    expect(normalisePhone('5876543210').ok).toBe(false);
    expect(failure(normalisePhone('+911234567890'))).toContain('6, 7, 8 or 9');
    expect(normalisePhone('+1234').ok).toBe(false);
    expect(normalisePhone('+12345678901234567').ok).toBe(false);
    expect(normalisePhone('98765abc43').ok).toBe(false);
    expect(normalisePhone('9.87654E+09').ok).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Bharat@TinyData.IN ')).toEqual(ok('bharat@tinydata.in'));
    expect(normaliseEmail('mailto:x@y.co')).toEqual(ok('x@y.co'));
  });

  it('rejects empty and malformed addresses', () => {
    expect(normaliseEmail('   ')).toMatchObject({ ok: false, message: 'Email is required' });
    expect(normaliseEmail('nope').ok).toBe(false);
    expect(normaliseEmail('a@b').ok).toBe(false);
    expect(normaliseEmail('a b@c.in').ok).toBe(false);
    expect(normaliseEmail(`${'x'.repeat(250)}@a.in`).ok).toBe(false);
  });
});

describe('normaliseCustomerType', () => {
  it('reads the codes and their long forms', () => {
    expect(normaliseCustomerType('FF')).toEqual(ok('FF'));
    expect(normaliseCustomerType(' ff ')).toEqual(ok('FF'));
    expect(normaliseCustomerType('Freight Forwarder')).toEqual(ok('FF'));
    expect(normaliseCustomerType('CB')).toEqual(ok('CB'));
    expect(normaliseCustomerType('Customs Broker')).toEqual(ok('CB'));
    expect(normaliseCustomerType('CHA')).toEqual(ok('CB'));
  });

  it('rejects anything else', () => {
    expect(normaliseCustomerType('')).toMatchObject({ ok: false });
    expect(failure(normaliseCustomerType('Airline'))).toContain('Airline');
  });
});

describe('normaliseSurveyType', () => {
  it('reads the three values and common shorthands', () => {
    expect(normaliseSurveyType('DOMESTIC')).toEqual(ok('DOMESTIC'));
    expect(normaliseSurveyType('dom')).toEqual(ok('DOMESTIC'));
    expect(normaliseSurveyType('D')).toEqual(ok('DOMESTIC'));
    expect(normaliseSurveyType('Intl')).toEqual(ok('INTERNATIONAL'));
    expect(normaliseSurveyType('International')).toEqual(ok('INTERNATIONAL'));
    expect(normaliseSurveyType('both')).toEqual(ok('BOTH'));
    expect(normaliseSurveyType('Domestic & International')).toEqual(ok('BOTH'));
    expect(normaliseSurveyType('Domestic / International')).toEqual(ok('BOTH'));
    expect(normaliseSurveyType('Domestic and International')).toEqual(ok('BOTH'));
  });

  it('rejects anything else', () => {
    expect(normaliseSurveyType('').ok).toBe(false);
    expect(normaliseSurveyType('Regional').ok).toBe(false);
  });
});

describe('normaliseTags', () => {
  it('splits on ; | and , then trims and de-duplicates', () => {
    expect(normaliseTags('vip; north | Priority, vip ,  ')).toEqual(ok(['vip', 'north', 'Priority']));
    expect(normaliseTags('')).toEqual(ok([]));
  });

  it('rejects over-long tags and too many tags', () => {
    expect(normaliseTags('x'.repeat(41)).ok).toBe(false);
    expect(normaliseTags(Array.from({ length: 21 }, (_, i) => `t${i}`).join(';')).ok).toBe(false);
  });
});

describe('names', () => {
  it('collapses whitespace and enforces length', () => {
    expect(normaliseName('  Falcon   Freight  ')).toEqual(ok('Falcon Freight'));
    expect(normaliseName('   ')).toMatchObject({ ok: false, message: 'Name is required' });
    expect(normaliseName('x'.repeat(201)).ok).toBe(false);
    expect(normaliseContactPerson('')).toEqual(ok(''));
    expect(normaliseContactPerson('x'.repeat(121)).ok).toBe(false);
  });
});
