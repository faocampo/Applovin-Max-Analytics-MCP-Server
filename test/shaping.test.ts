import { describe, expect, it } from 'vitest';
import { shapeResponse, TRUNCATION_HINT } from '../src/shaping.js';

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    i,
  }));

const big = { maxRows: 1_000, maxBytes: 1_000_000 };

describe('shapeResponse (json)', () => {
  it('wraps AppLovin { results, count } into a compact envelope', () => {
    const body = JSON.stringify({ code: 200, results: rows(2), count: 2 });
    const out = shapeResponse(body, 'json', big);
    expect(JSON.parse(out.text)).toEqual({
      rows_returned: 2,
      rows_total: 2,
      truncated: false,
      rows: rows(2),
    });
    expect(out).toMatchObject({ rowsReturned: 2, rowsTotal: 2, truncated: false });
  });

  it('accepts a bare array and caps rows with a hint', () => {
    const out = shapeResponse(JSON.stringify(rows(10)), 'json', {
      maxRows: 3,
      maxBytes: 1_000_000,
    });
    const parsed = JSON.parse(out.text);
    expect(parsed).toMatchObject({ rows_returned: 3, rows_total: 10, truncated: true });
    expect(parsed.hint).toContain('Showing 3 of 10 rows');
    expect(parsed.rows).toHaveLength(3);
  });

  it('uses the server-reported count when larger than the page', () => {
    const body = JSON.stringify({ results: rows(2), count: 50 });
    expect(JSON.parse(shapeResponse(body, 'json', big).text)).toMatchObject({
      rows_total: 50,
      truncated: true,
    });
  });

  it('shrinks rows until the payload fits the byte budget', () => {
    const out = shapeResponse(JSON.stringify(rows(200)), 'json', { maxRows: 200, maxBytes: 2_000 });
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(2_000);
    expect(out.truncated).toBe(true);
    expect(out.rowsReturned).toBeLessThan(200);
  });

  it('passes through other JSON and non-JSON bodies, truncating by bytes', () => {
    expect(shapeResponse('{"code":200,"message":"ok"}', 'json', big).text).toBe(
      '{"code":200,"message":"ok"}',
    );
    const html = `<html>${'x'.repeat(50)}</html>`;
    const out = shapeResponse(html, 'json', { maxRows: 10, maxBytes: 20 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain('[Response truncated at 20 bytes.');
    expect(shapeResponse('plain', 'json', big)).toMatchObject({ text: 'plain', truncated: false });
  });
});

describe('shapeResponse (csv)', () => {
  const csv = ['day,revenue', '2026-10-01,1.5', '2026-10-02,2.5', '2026-10-03,3.5', ''].join(
    '\r\n',
  );

  it('keeps the header and all rows when within limits', () => {
    expect(shapeResponse(csv, 'csv', big)).toEqual({
      text: 'day,revenue\n2026-10-01,1.5\n2026-10-02,2.5\n2026-10-03,3.5',
      rowsReturned: 3,
      rowsTotal: 3,
      truncated: false,
    });
  });

  it('caps rows and appends a hint line', () => {
    const out = shapeResponse(csv, 'csv', { maxRows: 1, maxBytes: 1_000 });
    expect(out.text).toBe(`day,revenue\n2026-10-01,1.5\n# Showing 1 of 3 rows. ${TRUNCATION_HINT}`);
  });

  it('respects the byte budget', () => {
    const out = shapeResponse(csv, 'csv', { maxRows: 10, maxBytes: 30 });
    expect(out.rowsReturned).toBe(1);
  });

  it('handles an empty body', () => {
    expect(shapeResponse('', 'csv', big)).toEqual({
      text: '',
      rowsReturned: 0,
      rowsTotal: 0,
      truncated: false,
    });
  });
});
