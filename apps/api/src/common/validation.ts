import { BadRequestException } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/** Validates input with zod. The error lists field paths and messages, never the submitted values. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      issues: result.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
