// MOB-UI.3 — pure form-validation helper shared by the Form primitive.
// Maps a Zod safeParse failure to a { 'dotted.path': firstMessage } map
// that FormField reads by `name`. Kept RN-free so it runs under vitest.
// Mirrors the issue-mapping shape used by src/lib/validate.js on web.

/**
 * @param {import('zod').ZodType} schema
 * @param {unknown} values
 * @returns {Record<string,string>} field path → first error message ({} if valid)
 */
export function collectZodErrors(schema, values) {
  const parsed = schema.safeParse(values)
  if (parsed.success) return {}
  const errors = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.')
    if (!(key in errors)) errors[key] = issue.message // first error per field wins
  }
  return errors
}
