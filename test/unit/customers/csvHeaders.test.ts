import { describe, expect, it } from 'vitest';

import { mapHeaders, matchHeader, normaliseHeader } from '../../../src/modules/customers/domain/csvHeaders.js';

describe('matchHeader', () => {
  it('ignores case, spaces, punctuation and bracketed hints', () => {
    expect(matchHeader('Name')).toBe('name');
    expect(matchHeader(' NAME ')).toBe('name');
    expect(matchHeader('Organisation Name')).toBe('name');
    expect(matchHeader('Company')).toBe('name');
    expect(matchHeader('Contact Person')).toBe('contactPerson');
    expect(matchHeader('contact_person')).toBe('contactPerson');
    expect(matchHeader('E-mail')).toBe('email');
    expect(matchHeader('E-Mail Address')).toBe('email');
    expect(matchHeader('Email ID')).toBe('email');
    expect(matchHeader('Mobile')).toBe('phone');
    expect(matchHeader('Mobile No.')).toBe('phone');
    expect(matchHeader('Phone Number')).toBe('phone');
    expect(matchHeader('WhatsApp')).toBe('phone');
    expect(matchHeader('Type (FF/CB)')).toBe('type');
    expect(matchHeader('Stakeholder Type')).toBe('type');
    expect(matchHeader('SURVEY TYPE')).toBe('surveyType');
    expect(matchHeader('Survey Type [DOMESTIC|INTERNATIONAL|BOTH]')).toBe('surveyType');
    expect(matchHeader('Operations')).toBe('surveyType');
    expect(matchHeader('Tags')).toBe('tags');
    expect(matchHeader('Labels')).toBe('tags');
  });

  it('returns null for unknown headers', () => {
    expect(matchHeader('GSTIN')).toBeNull();
    expect(matchHeader('')).toBeNull();
  });

  it('normaliseHeader strips a stray BOM', () => {
    expect(normaliseHeader('\uFEFFName')).toBe('name');
  });
});

describe('mapHeaders', () => {
  it('maps every template column and reports nothing missing', () => {
    const map = mapHeaders(['Name', 'Contact person', 'Email', 'Phone', 'Type', 'Survey type', 'Tags']);
    expect(map.columns).toEqual({ name: 0, contactPerson: 1, email: 2, phone: 3, type: 4, surveyType: 5, tags: 6 });
    expect(map.missing).toEqual([]);
    expect(map.ignored).toEqual([]);
  });

  it('reports missing required columns and ignores unknown or repeated ones', () => {
    const map = mapHeaders(['Name', 'GSTIN', 'Email', 'E-mail', 'Mobile', '']);
    expect(map.columns).toEqual({ name: 0, email: 2, phone: 4 });
    expect(map.matched).toEqual({ name: 'Name', email: 'Email', phone: 'Mobile' });
    expect(map.ignored).toEqual(['GSTIN', 'E-mail']);
    expect(map.missing).toEqual(['contactPerson', 'type', 'surveyType']);
  });

  it('tags are optional', () => {
    expect(mapHeaders(['Name', 'Contact', 'Email', 'Phone', 'Type', 'Survey']).missing).toEqual([]);
  });
});
