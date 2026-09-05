import { NextResponse } from 'next/server'
import { z } from 'zod'
import { UUID_SHAPE } from './uuid-shape'

/**
 * UUID-shaped string validator matching Postgres's `uuid` type behaviour.
 *
 * Zod 4's built-in `z.string().uuid()` is strict about the RFC 4122 version
 * digit (only v1-v8), but Postgres's `uuid` type accepts any 36-char hex
 * string. The seeded Stillorgan location ID (a0000000-0000-0000-0000-000000000001)
 * is technically not RFC-compliant — version digit is 0 — but is happily
 * stored and queried by Postgres. Use this validator for any UUID-shaped
 * input that originates from our DB.
 */
export const uuidLike = z.string().regex(
  UUID_SHAPE,
  'Must be a 36-character UUID-shaped string'
)

/**
 * Parse and validate a request body against a Zod schema.
 *
 * Returns one of:
 *   { ok: true, data: <parsed body> }
 *   { ok: false, response: <NextResponse 400> }
 *
 * Usage:
 *   const result = await validateBody(request, MySchema)
 *   if (!result.ok) return result.response
 *   const body = result.data
 *
 * Options:
 *   allowEmpty (default false): when true, an absent or empty body is
 *     treated as {} rather than a 400 error. Use for routes where all
 *     schema fields are optional and an empty POST is a valid no-op.
 *
 * The returned NextResponse has shape:
 *   { success: false, error: 'Invalid request body', issues: [{ path, message }, ...] }
 *
 * @template T
 * @param {Request} request
 * @param {import('zod').ZodType<T>} schema
 * @param {{ allowEmpty?: boolean }} [opts]
 * @returns {Promise<{ ok: true, data: T } | { ok: false, response: NextResponse }>}
 */
export async function validateBody(request, schema, opts = {}) {
  const { allowEmpty = false } = opts
  let raw
  try {
    raw = await request.json()
  } catch {
    if (allowEmpty) {
      raw = {}
    } else {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: 'Request body is not valid JSON' },
          { status: 400 }
        ),
      }
    }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid request body', issues },
        { status: 400 }
      ),
    }
  }

  return { ok: true, data: parsed.data }
}

/**
 * Validate a value (typically a query param or path param) against a schema.
 * Returns { ok, data } or { ok, response }. Same shape as validateBody but
 * doesn't read the request body.
 */
export function validate(value, schema) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid input', issues },
        { status: 400 }
      ),
    }
  }
  return { ok: true, data: parsed.data }
}
