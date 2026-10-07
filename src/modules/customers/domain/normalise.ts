/**
 * Field normalisers for customer data: the same rules apply to a CSV cell
 * and to a form field. Each returns either a clean value or a message.
 */
import type { CustomerSurveyType, CustomerType } from './csvTemplate.js';

export type Normalised<T> = { ok: true; value: T } | { ok: false; message: string };

export const NAME_MAX_LENGTH = 200;
export const CONTACT_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;
export const TAG_MAX_LENGTH = 40;
export const TAGS_MAX_COUNT = 20;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/** Collapses inner whitespace and trims. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normaliseName(raw: string, label = 'Name'): Normalised<string> {
  const value = cleanText(raw);
  if (value === '') return { ok: false, message: `${label} is required` };
  if (value.length > NAME_MAX_LENGTH) return { ok: false, message: `${label} is longer than ${NAME_MAX_LENGTH} characters` };
  return { ok: true, value };
}

export function normaliseContactPerson(raw: string): Normalised<string> {
  const value = cleanText(raw);
  if (value.length > CONTACT_MAX_LENGTH) {
    return { ok: false, message: `Contact person is longer than ${CONTACT_MAX_LENGTH} characters` };
  }
  return { ok: true, value };
}

/** Trim, lower-case, basic shape check. */
export function normaliseEmail(raw: string): Normalised<string> {
  const value = raw.trim().toLowerCase().replace(/^mailto:/, '');
  if (value === '') return { ok: false, message: 'Email is required' };
  if (value.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(value)) {
    return { ok: false, message: 'Email is not a valid address' };
  }
  return { ok: true, value };
}

/**
 * E.164-ish, India first:
 *   9876543210 / 09876543210 / 919876543210 / +91 98765 43210 → +919876543210
 *   +44 20 7946 0958 → +442079460958 (any country: + and 8–15 digits)
 * Spaces, dashes, dots and brackets are ignored; a leading 00 means +.
 */
export function normalisePhone(raw: string): Normalised<string> {
  const compact = raw.replace(/[\s().-]/g, '');
  if (compact === '') return { ok: false, message: 'Phone is required' };
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  if (withPlus.startsWith('+')) {
    const digits = withPlus.slice(1);
    if (!/^\d{8,15}$/.test(digits)) {
      return { ok: false, message: 'Phone must be + followed by 8 to 15 digits' };
    }
    if (digits.startsWith('91') && digits.length === 12 && !INDIAN_MOBILE.test(digits.slice(2))) {
      return { ok: false, message: 'Indian mobile numbers start with 6, 7, 8 or 9' };
    }
    return { ok: true, value: `+${digits}` };
  }

  if (!/^\d+$/.test(withPlus)) return { ok: false, message: 'Phone may contain only digits, spaces, dashes and a leading +' };
  const national =
    withPlus.length === 11 && withPlus.startsWith('0')
      ? withPlus.slice(1)
      : withPlus.length === 12 && withPlus.startsWith('91')
        ? withPlus.slice(2)
        : withPlus;
  if (INDIAN_MOBILE.test(national)) return { ok: true, value: `+91${national}` };
  return { ok: false, message: 'Phone must be a 10-digit Indian mobile or an international number starting with +' };
}

function letters(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '');
}

const TYPE_SYNONYMS: Record<CustomerType, readonly string[]> = {
  FF: ['FF', 'FREIGHTFORWARDER', 'FREIGHTFORWARDERS', 'FORWARDER', 'FORWARDERS', 'FORWARDING', 'FREIGHT', 'FREIGHTFORWARDING'],
  CB: ['CB', 'CUSTOMSBROKER', 'CUSTOMSBROKERS', 'CUSTOMBROKER', 'BROKER', 'BROKERS', 'CHA', 'CUSTOMSHOUSEAGENT', 'CUSTOMHOUSEAGENT', 'CUSTOMS'],
};

export function normaliseCustomerType(raw: string): Normalised<CustomerType> {
  const key = letters(raw);
  if (key === '') return { ok: false, message: 'Type is required (FF or CB)' };
  for (const [type, synonyms] of Object.entries(TYPE_SYNONYMS) as [CustomerType, readonly string[]][]) {
    if (synonyms.includes(key)) return { ok: true, value: type };
  }
  return { ok: false, message: `Type must be FF or CB (got "${raw.trim()}")` };
}

const SURVEY_SYNONYMS: Record<CustomerSurveyType, readonly string[]> = {
  DOMESTIC: ['DOMESTIC', 'DOM', 'D', 'DOMESTICONLY', 'NATIONAL'],
  INTERNATIONAL: ['INTERNATIONAL', 'INTL', 'INT', 'I', 'INTERNATIONALONLY', 'OVERSEAS'],
  BOTH: ['BOTH', 'B', 'ALL', 'DI', 'ID', 'DOMESTICINTERNATIONAL', 'INTERNATIONALDOMESTIC', 'DOMESTICANDINTERNATIONAL', 'INTERNATIONALANDDOMESTIC', 'DOMINTL', 'INTLDOM', 'DOMESTICINTL', 'INTLDOMESTIC'],
};

export function normaliseSurveyType(raw: string): Normalised<CustomerSurveyType> {
  const key = letters(raw);
  if (key === '') return { ok: false, message: 'Survey type is required (DOMESTIC, INTERNATIONAL or BOTH)' };
  for (const [surveyType, synonyms] of Object.entries(SURVEY_SYNONYMS) as [CustomerSurveyType, readonly string[]][]) {
    if (synonyms.includes(key)) return { ok: true, value: surveyType };
  }
  return { ok: false, message: `Survey type must be DOMESTIC, INTERNATIONAL or BOTH (got "${raw.trim()}")` };
}

/** Splits on ; | or , — trims, drops empties, de-duplicates case-insensitively, keeps first spelling. */
export function normaliseTags(raw: string): Normalised<string[]> {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[;|,]/)) {
    const tag = cleanText(part);
    if (tag === '') continue;
    if (tag.length > TAG_MAX_LENGTH) return { ok: false, message: `Tag "${tag}" is longer than ${TAG_MAX_LENGTH} characters` };
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > TAGS_MAX_COUNT) return { ok: false, message: `More than ${TAGS_MAX_COUNT} tags` };
  return { ok: true, value: tags };
}
