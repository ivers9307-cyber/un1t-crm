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

// .ilike(col, <bare value>) — a case-insensitive EQUALITY check written as a
// LIKE pattern. `_` and `%` are wildcards AND legal email/name characters, so
// an unescaped value matches a pattern rather than the value: `a_b@x.com` also
// matches `axb@x.com`, and `%@x.com` matches every address at the domain.
// Found 2026-08-07 in the inbound-email webhook (attacker-controlled From) plus
// five other lookups, after being hand-fixed twice before that. See
// src/lib/like-escape.js.
//
// A DELIBERATE substring search is not flagged: those spell the wildcards in
// the source (`'%hyrox%'`, `` `%${term}%` ``), which is the visible difference
// between "I meant a pattern" and "I meant equality".
const ESCAPE_HELPER = 'escapeLikePattern'

// Does the argument spell a wildcard in the SOURCE? Literal or template — for
// templates only the static parts count, since an interpolated value is
// exactly what we cannot vouch for.
function spellsWildcard(node) {
  if (!node) return false
  if (node.type === 'Literal') return typeof node.value === 'string' && /[%_]/.test(node.value)
  if (node.type === 'TemplateLiteral') {
    return (node.quasis || []).some((q) => /[%_]/.test((q.value && q.value.cooked) || ''))
  }
  return false
}

// escapeLikePattern(x) — including a namespaced form (like.escapeLikePattern).
function isEscaped(node) {
  if (!node || node.type !== 'CallExpression') return false
  const c = node.callee
  if (!c) return false
  if (c.type === 'Identifier') return c.name === ESCAPE_HELPER
  if (c.type === 'MemberExpression') return c.property && c.property.name === ESCAPE_HELPER
  return false
}

const noUnescapedIlikePattern = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow .ilike()/.like() whose pattern is an unescaped runtime value. Wrap it in escapeLikePattern() for an equality check, or spell the wildcards in the source for a deliberate substring search.',
    },
    schema: [],
    messages: {
      unescaped:
        ".ilike()/.like() takes a LIKE PATTERN, not a value — `_` and `%` are wildcards and both are legal in emails and names, so this matches more (or other) rows than intended. If this is a case-insensitive EQUALITY check, wrap the argument in escapeLikePattern() from @/lib/like-escape. If it is a deliberate substring search over trusted/sanitised input, spell the wildcards in the source (`%${term}%`) or annotate with an eslint-disable + reason.",
    },
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"]'(node) {
        const prop = node.callee.property && node.callee.property.name
        if (prop !== 'ilike' && prop !== 'like') return
        // PostgREST form is .ilike(column, pattern); anything else isn't ours.
        if (!node.arguments || node.arguments.length !== 2) return
        const pattern = node.arguments[1]
        if (spellsWildcard(pattern) || isEscaped(pattern)) return
        // A plain string literal with no wildcard is already an exact match.
        if (pattern.type === 'Literal' && typeof pattern.value === 'string') return
        context.report({ node: pattern, messageId: 'unescaped' })
      },
    }
  },
}

// A bare <button> inside a <form> defaults to type="submit" (HTML spec), so a
// tab pill, a close X or any secondary action placed in a form submits it —
// reloading/clearing the form, or firing onSubmit, on a click that was meant to
// do something else entirely. #1319 hand-fixed 36 of these across the campaign
// and email components; a repo-wide survey then found 301 untyped <button>s, so
// the convention (CLAUDE.md: "Every <button> in a <form> defaults to
// type='submit' — set type='button' on every non-submit") clearly needs a rule
// rather than memory.
//
// Precision-first, because this runs at ERROR level over the whole repo and a
// wrong flag on a shared primitive blocks every PR. Deliberate non-flags:
//   - no <form> ancestor in this file — outside a form the default is inert
//   - any explicit `type`, INCLUDING a dynamic `type={expr}`; a dynamic type is
//     still a deliberate choice and we cannot judge its value
//   - a `{...spread}` is present — the type may arrive through it
//   - an uppercase <Button> — only the lowercase intrinsic defaults to submit;
//     the repo's own primitive sets its own type
//
// KNOWN LIMIT: an AST rule only sees one JSX tree, so a button reached through a
// COMPONENT BOUNDARY (<form> renders <Foo/>, and <Foo/> renders the <button>) is
// invisible here. The rule is a floor, not an exhaustive check.
function isNamedJsxElement(node, name) {
  if (!node || node.type !== 'JSXElement') return false
  const open = node.openingElement
  const id = open && open.name
  return !!id && id.type === 'JSXIdentifier' && id.name === name
}

const noUntypedButtonInForm = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a lowercase <button> with no `type` attribute inside a <form> — it defaults to type=\"submit\". Does NOT flag buttons carrying a {...spread} (the type may come from it) or buttons reached through a component boundary (invisible to an AST rule).",
    },
    schema: [],
    messages: {
      untyped:
        'A <button> inside a <form> defaults to type="submit" (HTML spec), so this click submits the form. Set type="button" if it is a tab pill / close X / secondary action, or type="submit" if it genuinely is the form\'s primary action (CLAUDE.md invariant).',
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        if (!isNamedJsxElement(node, 'button')) return
        const attrs = (node.openingElement && node.openingElement.attributes) || []
        for (const attr of attrs) {
          // A spread may carry `type` — a false positive on a shared UI
          // primitive is worse than the miss.
          if (attr.type === 'JSXSpreadAttribute') return
          if (attr.type === 'JSXAttribute' && attr.name && attr.name.name === 'type') return
        }
        const ancestors = context.sourceCode.getAncestors(node)
        if (!ancestors.some((a) => isNamedJsxElement(a, 'form'))) return
        context.report({ node: node.openingElement, messageId: 'untyped' })
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
    'no-unescaped-ilike-pattern': noUnescapedIlikePattern,
    'no-untyped-button-in-form': noUntypedButtonInForm,
  },
}
