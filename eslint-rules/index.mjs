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

// new Date(`...T...Z`) — appending Z parses the (interpolated) string as UTC.
// On a Dublin wall-clock date/time that silently adds the BST (+1h) offset.
const noZuluTemplateDate = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow new Date(`...T...Z`) — parses an interpolated wall-clock string as UTC (adds the BST offset).' },
    schema: [],
    messages: {
      z: 'new Date(`…T…Z`) parses the string as UTC — on a Dublin wall-clock date/time this silently adds the BST (+1h) offset. Use localToUtc()/dublinWallClockToMs(), or the noon-UTC date-label pattern. If the components are genuinely UTC, annotate with an eslint-disable + reason.',
    },
  },
  create(context) {
    return {
      'NewExpression[callee.name="Date"]'(node) {
        const arg = node.arguments && node.arguments[0]
        if (!arg || arg.type !== 'TemplateLiteral') return
        const quasis = arg.quasis || []
        if (!quasis.length) return
        const lastQ = quasis[quasis.length - 1]
        const lastCooked = (lastQ.value && lastQ.value.cooked) || ''
        const hasT = quasis.some((q) => ((q.value && q.value.cooked) || '').includes('T'))
        // High precision: only flag `...T${time}Z` — an interpolation directly
        // before a lone trailing `Z` (the wall-clock-TIME-as-UTC bug). This
        // deliberately does NOT flag legit literal-time forms: `${d}T12:00:00Z`
        // (noon date-label anchor) or `${d}T00:00:00Z` (UTC date math, e.g.
        // addDaysISO) — there the time sits in the literal, not an expression.
        if (hasT && lastCooked.trim() === 'Z') {
          context.report({ node, messageId: 'z' })
        }
      },
    }
  },
}

// new Date().toISOString().slice/split — the UTC date of "now", which differs
// from the Dublin date around midnight during BST (off-by-one for a business
// "today"). Bare new Date().toISOString() (a UTC timestamp) is fine and NOT
// flagged — only the date-extraction via .slice/.split is.
const noUtcToday = {
  meta: {
    type: 'problem',
    docs: { description: "Disallow new Date().toISOString().slice/split — the UTC date of now; use dublinTodayStr() for a business 'today'." },
    schema: [],
    messages: {
      utcToday: "new Date().toISOString() is the UTC date of now — during BST it differs from the Dublin date around midnight, an off-by-one for a business 'today'. Use dublinTodayStr() from @/lib/dublin-time. If you genuinely need the UTC date (filename/storage key), annotate with an eslint-disable + reason.",
    },
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"]'(node) {
        const prop = node.callee.property && node.callee.property.name
        if (prop !== 'slice' && prop !== 'split') return
        const inner = node.callee.object
        if (!inner || inner.type !== 'CallExpression') return
        const ic = inner.callee
        if (!ic || ic.type !== 'MemberExpression' || !ic.property || ic.property.name !== 'toISOString') return
        const dateNode = ic.object
        if (!dateNode || dateNode.type !== 'NewExpression') return
        if (!dateNode.callee || dateNode.callee.name !== 'Date') return
        if (dateNode.arguments && dateNode.arguments.length > 0) return // new Date(x) — not "now"
        context.report({ node, messageId: 'utcToday' })
      },
    }
  },
}

// Low-contrast status chips on the light theme (operator feedback 2026-07-03:
// the pipeline credits pill rendered green-on-green and was unreadable).
// Two banned recipes, both requiring bg + text in the SAME string so we don't
// false-positive on classes split across ternaries (precision-first, like
// no-zulu-template-date):
//   1. dark-theme chip ported to the light theme: bg-*-900/950 + text-*-100..400
//   2. light tint chip with washed-out text:      bg-*-50 | bg-*-500/10..25 + text-*-300/400
// The fix is the CLAUDE.md convention: status text on light cards uses the
// -700 ramp. Dark surfaces (src/app/tv, src/app/present) are excluded in
// eslint.guardrails.config.mjs, not here.
const DARK_CHIP_BG = /\bbg-[a-z]+-9[05]0(?:\/\d+)?\b/
const DARK_CHIP_TEXT = /\btext-[a-z]+-[1-4]00\b/
const LIGHT_TINT_BG = /\bbg-[a-z]+-(?:50\b|500\/(?:10|15|20|25)\b)/
const LOW_RAMP_TEXT = /\btext-[a-z]+-[34]00\b/

function chipViolation(str) {
  if (typeof str !== 'string' || !str.includes('text-')) return null
  if (DARK_CHIP_BG.test(str) && DARK_CHIP_TEXT.test(str)) return 'darkChip'
  if (LIGHT_TINT_BG.test(str) && LOW_RAMP_TEXT.test(str)) return 'lowContrast'
  return null
}

const noLowContrastChip = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow low-contrast status-chip class recipes on the light theme: dark-theme chips (bg-*-900 + text-*-400) and washed-out tints (bg-*-500/10..25 + text-*-300/400). Status text on light cards uses the -700 ramp.',
    },
    schema: [],
    messages: {
      darkChip:
        'Dark-theme chip recipe (bg-*-900/950 + low text ramp) on the light theme — unreadable (the green-on-green credits pill, 2026-07-03). Use the light chip idiom: bg-<color>-500/10 text-<color>-700. Genuinely dark surfaces (TV/present) are path-excluded in eslint.guardrails.config.mjs.',
      lowContrast:
        'Status text on light cards needs the -700 ramp (CLAUDE.md) — text-*-300/400 on a light tint is unreadable. Change text-<color>-300/400 → text-<color>-700.',
    },
  },
  create(context) {
    function check(node, value) {
      const id = chipViolation(value)
      if (id) context.report({ node, messageId: id })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateLiteral(node) {
        // Join the literal parts: a recipe split across ${...} boundaries is
        // still caught when both halves live in the template's static text.
        const joined = (node.quasis || [])
          .map((q) => (q.value && q.value.cooked) || '')
          .join(' ')
        check(node, joined)
      },
    }
  },
}

export default {
  rules: {
    'no-catch-on-supabase-builder': noCatchOnSupabaseBuilder,
    'no-uncapped-supabase-limit': noUncappedSupabaseLimit,
    'no-zulu-template-date': noZuluTemplateDate,
    'no-utc-today': noUtcToday,
    'no-low-contrast-chip': noLowContrastChip,
  },
}
