import { NextResponse } from 'next/server'

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
 * The returned NextResponse has shape:
 *   { success: false, error: 'Invalid request body', issues: [{ path, message }, ...] }
 *
 * @template T
 * @param {Request} request
 * @param {import('zod').ZodType<T>} schema
 * @returns {Promise<{ ok: true, data: T } | { ok: false, response: NextResponse }>}
 */
export async function validateBody(request, schema) {
  let raw
  try {
    raw = await request.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Request body is not valid JSON' },
        { status: 400 }
      ),
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
