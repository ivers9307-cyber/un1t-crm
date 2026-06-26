// Local ESLint rules — the "guardrails" against the audit's recurring defect
// classes (2026-06-25 estate audit, P1-1). Run via the scoped
// eslint.guardrails.config.mjs (`npm run check:guardrails`), NOT the main lint.
// Design: docs/superpowers/specs/2026-06-25-guardrails-lint-design.md.

// Roots of a PostgREST query-builder chain (the thenable). NOTE: storage is
// deliberately excluded — db.storage.from(b).upload/download/remove(...) return
// REAL Promises, so .catch on them is fine (handled by chainContainsStorage).
const SUPABASE_ROOTS = new Set(['from', 'rpc'])

// Walk DOWN a member/call chain (following .callee.object / .object); return
// true if any call in it is .from()/.rpc()/.storage() — i.e. the chain is a
// supabase query builder.
function chainRootIsSupabase(node) {
  let cur = node
  while (cur) {
    if (cur.type === 'CallExpression') {
      const c = cur.callee
      if (c && c.type === 'MemberExpression' && SUPABASE_ROOTS.has(c.property && c.property.name)) return true
      cur = c && c.type === 'MemberExpression' ? c.object : null
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object
    } else {
      cur = null
    }
  }
  return false
}

// Walk DOWN a chain looking for a call to method `name` (e.g. 'range', 'then').
function chainHasMethod(node, name) {
  let cur = node
  while (cur) {
    if (cur.type === 'CallExpression') {
      const c = cur.callee
      if (c && c.type === 'MemberExpression' && c.property && c.property.name === name) return true
      cur = c && c.type === 'MemberExpression' ? c.object : null
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object
    } else {
      cur = null
    }
  }
  return false
}

// Walk DOWN a chain; true if it accesses `.storage` (db.storage.*). Storage
// operations (upload/download/remove) return REAL Promises, so .catch/.finally
// on them is legitimate — they must NOT be flagged as builder misuse.
function chainContainsStorage(node) {
  let cur = node
  while (cur) {
    if (cur.type === 'MemberExpression') {
      if (cur.property && cur.property.name === 'storage') return true
      cur = cur.object
    } else if (cur.type === 'CallExpression') {
      cur = cur.callee
    } else {
      return false
    }
  }
  return false
}

const noCatchOnSupabaseBuilder = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow .catch()/.finally() directly on a supabase query builder. The builder is a thenable, not a Promise — .then() fires the request and returns a real Promise, but .catch/.finally throw a synchronous TypeError and the query never runs.',
    },
    schema: [],
    messages: {
      noCatch:
        'supabase query builders are thenables, not Promises — they have no .catch/.finally, so this throws a TypeError and the query never runs. Wrap it in try/await/catch instead (see CLAUDE.md invariants).',
    },
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"]'(node) {
        const prop = node.callee.property && node.callee.property.name
        if (prop !== 'catch' && prop !== 'finally') return
        const obj = node.callee.object
        if (!obj) return
        // Allowed: <builder>.then(...).catch(...) — the .then() returns a real
        // Promise that legitimately owns .catch/.finally.
        if (
          obj.type === 'CallExpression' &&
          obj.callee &&
          obj.callee.type === 'MemberExpression' &&
          obj.callee.property &&
          obj.callee.property.name === 'then'
        ) {
          return
        }
        // Storage ops (upload/download/remove) return real Promises — .catch ok.
        if (chainContainsStorage(obj)) return
        if (chainRootIsSupabase(obj)) {
          context.report({ node, messageId: 'noCatch' })
        }
      },
    }
  },
}

const noUncappedSupabaseLimit = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow .limit(N>=1000) on a supabase builder without .range(). PostgREST caps every response at 1000 rows regardless of .limit(), so .limit(20000) silently returns <=1000.',
    },
    schema: [],
    messages: {
      cap:
        'PostgREST caps results at 1000 rows regardless of .limit({{n}}). Paginate with selectAll()/.range(), or annotate a deliberate cap with an eslint-disable + reason.',
    },
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.name="limit"]'(node) {
        const arg = node.arguments && node.arguments[0]
        const n = arg && arg.type === 'Literal' && typeof arg.value === 'number' ? arg.value : null
        if (n == null || n < 1000) return
        if (!chainRootIsSupabase(node.callee.object)) return
        if (chainHasMethod(node.callee.object, 'range')) return // already paginated
        context.report({ node, messageId: 'cap', data: { n: String(n) } })
      },
    }
  },
}

export default {
  rules: {
    'no-catch-on-supabase-builder': noCatchOnSupabaseBuilder,
    'no-uncapped-supabase-limit': noUncappedSupabaseLimit,
  },
}
