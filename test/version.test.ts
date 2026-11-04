import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/version.js';

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SERVER_NAME).toBe(pkg.name);
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
