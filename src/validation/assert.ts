import { badRequest } from '../http/errors.js';

/** Field-level assertions. Each throws a 400 naming the offending path. */

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field}: must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertNonEmptyArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`${field}: must be a non-empty array`);
  }
  return value;
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${field}: required, must be a string`);
  }
  return value;
}

export function assertOptionalPositiveInt(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest(`${field}: must be a positive integer`);
  }
}

export function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw badRequest(`${field}: must be a boolean`);
  }
}

export function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw badRequest(`${field}: must be a string`);
  }
}

export function assertPattern(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) {
    throw badRequest(`${field}: must match ${pattern.source}`);
  }
}

export function assertNoDuplicates(values: string[], field: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw badRequest(`${field}: duplicate value ${JSON.stringify(v)}`);
    seen.add(v);
  }
}
