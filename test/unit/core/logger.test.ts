import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { LOG_REDACT, redactUrl } from '../../../src/core/logger.js';

/* Bearer tokens, link sessions and the raw link token in a public URL are
   credentials: none of them may reach the API log. */

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('logger redaction', () => {
  it('censors the bearer token, cookies, the link session and the :token param', () => {
    const { lines, stream } = capture();
    const log = pino({ redact: LOG_REDACT }, stream);
    log.info({
      req: {
        url: '/api/v1/cycles',
        headers: { authorization: 'Bearer eyJhbGciOi.secret', cookie: 'sid=abc', 'x-csq-link-token': 'link.secret', accept: 'application/json' },
        params: { token: 'raw-invitation-token' },
      },
    });
    const line = lines.join('');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('sid=abc');
    expect(line).not.toContain('raw-invitation-token');
    expect(line).toContain('application/json');
    expect(JSON.parse(line).req.headers.authorization).toBe('[redacted]');
  });

  it.each([
    ['/api/v1/public/assess/AbC123-xyz', '/api/v1/public/assess/[redacted]'],
    ['/api/v1/public/assess/AbC123-xyz/form?x=1', '/api/v1/public/assess/[redacted]/form?x=1'],
    ['/api/v1/public/onboarding/tok_9', '/api/v1/public/onboarding/[redacted]'],
    ['/api/v1/cycles/66aa/participants', '/api/v1/cycles/66aa/participants'],
  ])('redactUrl(%j)', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});
