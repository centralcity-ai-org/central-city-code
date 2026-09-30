import { createHash } from 'node:crypto';

/**
 * JSON canonicalization in the style of RFC 8785 (JCS): object members sorted by UTF-16 code
 * units, no insignificant whitespace, ECMAScript number and string serialization. Values must be
 * I-JSON: finite numbers, well-formed strings, plain objects and arrays only. Object members whose
 * value is `undefined` are omitted (JSON semantics); `undefined` inside arrays is rejected.
 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_DEPTH = 64;

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalizationError('Strings must be well-formed.');
  return JSON.stringify(value);
}

function serialize(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('Numbers must be finite.');
      // ECMAScript Number serialization is the JCS number format; JSON.stringify(-0) is "0".
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`Unsupported JSON value of type ${typeof value}.`);
  }
  if (depth > MAX_DEPTH) throw new CanonicalizationError('Value is nested too deeply.');
  const object = value as object;
  if (seen.has(object)) throw new CanonicalizationError('Cyclic values cannot be canonicalized.');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object
        .map((item) => {
          if (item === undefined) throw new CanonicalizationError('Arrays cannot hold undefined.');
          return serialize(item, depth + 1, seen);
        })
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null)
      throw new CanonicalizationError('Only plain objects can be canonicalized.');
    const record = object as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is exactly the JCS member order.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${serializeString(key)}:${serialize(record[key], depth + 1, seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, 0, new Set());
}

export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** Stable content hash: `sha256:<hex>` of the canonical JSON form. Independent of key order. */
export function canonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}
