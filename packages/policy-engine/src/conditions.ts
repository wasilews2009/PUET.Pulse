import type { Condition, Operand } from './types';

/**
 * Safe evaluator for admin-authored JSON conditions. There is no `eval`, no
 * function calls and no prototype access: variables resolve only through own
 * enumerable properties, and `__proto__`, `constructor` and `prototype` are
 * rejected.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 32;

export class ConditionError extends Error {}

export type ConditionContext = Record<string, unknown>;

export function resolvePath(ctx: ConditionContext, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
    throw new ConditionError('Invalid variable path');
  }
  let current: unknown = ctx;
  for (const segment of path.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new ConditionError(`Forbidden path segment: ${segment}`);
    }
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current instanceof Date ? current.getTime() : current;
}

function operand(ctx: ConditionContext, op: Operand): unknown {
  if (Array.isArray(op)) return op.map((o) => operand(ctx, o));
  if (op !== null && typeof op === 'object') {
    if (Object.keys(op).length !== 1 || !('var' in op)) {
      throw new ConditionError('Operand objects must be exactly { "var": "<path>" }');
    }
    return resolvePath(ctx, op.var);
  }
  return op;
}

function pair(ctx: ConditionContext, args: unknown): [unknown, unknown] {
  if (!Array.isArray(args) || args.length !== 2) {
    throw new ConditionError('Binary operator expects exactly two operands');
  }
  return [operand(ctx, args[0] as Operand), operand(ctx, args[1] as Operand)];
}

function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

export function evaluateCondition(cond: Condition, ctx: ConditionContext, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new ConditionError('Condition nesting too deep');
  if (typeof cond === 'boolean') return cond;
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
    throw new ConditionError('Condition must be a boolean or an operator object');
  }
  const keys = Object.keys(cond);
  if (keys.length !== 1) throw new ConditionError('Condition object must have exactly one operator');
  const op = keys[0] as string;
  const args = (cond as Record<string, unknown>)[op];

  switch (op) {
    case 'all':
      if (!Array.isArray(args)) throw new ConditionError('"all" expects an array');
      return args.every((c) => evaluateCondition(c as Condition, ctx, depth + 1));
    case 'any':
      if (!Array.isArray(args)) throw new ConditionError('"any" expects an array');
      return args.some((c) => evaluateCondition(c as Condition, ctx, depth + 1));
    case 'not':
      return !evaluateCondition(args as Condition, ctx, depth + 1);
    case 'eq': {
      const [a, b] = pair(ctx, args);
      return a === b;
    }
    case 'neq': {
      const [a, b] = pair(ctx, args);
      return a !== b;
    }
    case 'in': {
      const [needle, haystack] = pair(ctx, args);
      return Array.isArray(haystack) && haystack.includes(needle);
    }
    case 'intersects': {
      const [a, b] = pair(ctx, args);
      return Array.isArray(a) && Array.isArray(b) && a.some((x) => b.includes(x));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = pair(ctx, args);
      const c = compare(a, b);
      if (c === undefined) return false;
      return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
    }
    case 'exists': {
      const v = operand(ctx, args as Operand);
      return v !== undefined && v !== null;
    }
    default:
      throw new ConditionError(`Unknown operator: ${op}`);
  }
}

/** Validates a condition's shape without evaluating it (used by the Admin Panel). */
export function validateCondition(cond: unknown): string | null {
  try {
    evaluateCondition(cond as Condition, {});
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid condition';
  }
}
