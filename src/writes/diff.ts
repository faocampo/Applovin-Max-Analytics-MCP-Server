import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function stateHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface DiffEntry {
  path: string;
  op: 'add' | 'remove' | 'change';
  before?: unknown;
  after?: unknown;
}

const IDENTITY_KEYS = ['id', 'ad_network', 'network', 'country', 'country_code', 'name'] as const;

/**
 * Identity of an array element, so reordered or inserted entries diff by
 * meaning rather than position. AppLovin documents ad network settings as one
 * object per network keyed by its API name; other lists use common id fields.
 */
export function identityOf(element: unknown): string | undefined {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return undefined;
  const o = element as Record<string, unknown>;
  for (const key of IDENTITY_KEYS) {
    const v = o[key];
    if (typeof v === 'string' || typeof v === 'number') return `${key}=${v}`;
  }
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] && o[keys[0]] && typeof o[keys[0]] === 'object') {
    return keys[0];
  }
  return undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Structural diff of two JSON values. Paths look like `bid_floors[country=US].cpm`. */
export function diffJson(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (before === undefined) return [{ path, op: 'add', after }];
  if (after === undefined) return [{ path, op: 'remove', before }];

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffJson(before[k], after[k], path ? `${path}.${k}` : k));
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const ids = (arr: unknown[]) => arr.map(identityOf);
    const bIds = ids(before);
    const aIds = ids(after);
    const keyed =
      bIds.every((id) => id !== undefined) &&
      aIds.every((id) => id !== undefined) &&
      new Set(bIds).size === bIds.length &&
      new Set(aIds).size === aIds.length;
    if (keyed) {
      const bMap = new Map(before.map((el, i) => [bIds[i] as string, el]));
      const aMap = new Map(after.map((el, i) => [aIds[i] as string, el]));
      const all = [...new Set([...bMap.keys(), ...aMap.keys()])].sort();
      return all.flatMap((id) => diffJson(bMap.get(id), aMap.get(id), `${path}[${id}]`));
    }
    const len = Math.max(before.length, after.length);
    return Array.from({ length: len }, (_, i) =>
      diffJson(before[i], after[i], `${path}[${i}]`),
    ).flat();
  }

  return [{ path, op: 'change', before, after }];
}
