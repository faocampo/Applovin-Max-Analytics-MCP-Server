import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED, redactUrl } from '../src/applovin/redact.js';

const KEY = 'sk_live_0123456789abcdef';

describe('createRedactor', () => {
  const redact = createRedactor([KEY]);

  it('removes the configured secret wherever it appears', () => {
    expect(redact(`error with ${KEY} inside and ${KEY} again`)).toBe(
      `error with ${REDACTED} inside and ${REDACTED} again`,
    );
  });

  it('removes credential query parameters even for unknown values', () => {
    expect(
      redact('GET https://r.applovin.com/maxReport?api_key=other-secret&start=2026-01-01'),
    ).toBe(`GET https://r.applovin.com/maxReport?api_key=${REDACTED}&start=2026-01-01`);
    expect(createRedactor([])('x?management_key=abc')).toBe(`x?management_key=${REDACTED}`);
  });

  it('removes the URL-encoded form of the secret', () => {
    const special = 'key+with/special=chars';
    const r = createRedactor([special]);
    expect(r(`raw ${special} enc ${encodeURIComponent(special)}`)).toBe(
      `raw ${REDACTED} enc ${REDACTED}`,
    );
  });

  it('ignores secrets too short to redact safely', () => {
    expect(createRedactor(['abc', undefined])('abc def')).toBe('abc def');
  });

  it('redacts URLs', () => {
    const url = new URL(`https://r.applovin.com/maxReport?start=2026-01-01&api_key=${KEY}`);
    expect(redactUrl(url, redact)).toBe(
      `https://r.applovin.com/maxReport?start=2026-01-01&api_key=${REDACTED}`,
    );
  });
});
