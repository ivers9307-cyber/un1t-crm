// DBTYPES.1 — the testable parts of scripts/check-types.mjs.

/** A file opts in with `// @ts-check` near its top. */
export function optedIn(src) {
  return /^\s*\/\/ @ts-check\b/m.test(String(src).slice(0, 400))
}

/** Error messages supabase-js encodes in the result type of a bad select. */
export function selectErrorIn(typeText) {
  const m = /column '[^']*' does not exist on '[^']*'|could not find the relation[^"`]*|Could not embed because[^"`]*|referenced relation[^"`]*does not exist[^"`]*/i.exec(typeText)
  return m ? m[0] : null
}

/** Every .select('…') in the file whose result type is an error. */
export function findSelectErrors(ts, checker, sourceFile) {
  const out = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'select') {
      const text = checker.typeToString(checker.getTypeAtLocation(node), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)
      const message = selectErrorIn(text)
      if (message) out.push({ pos: node.expression.name.getStart(sourceFile), message })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}

/** What scripts/fixtures/db-types-must-fail.js must keep producing. */
export const REQUIRED_PROOFS = Object.freeze([
  "column 'created_at' does not exist on 'sequence_enrollments'",
  "column 'nope' does not exist on 'contacts'",
  'No overload matches this call',
  'increment_step_sent',
  'not_a_column',
  'possibly',
])

export function missingProofs(hits) {
  return REQUIRED_PROOFS.filter((p) => !hits.some((h) => h.includes(p)))
}
