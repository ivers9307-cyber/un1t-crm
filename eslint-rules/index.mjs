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

// `const { data } = await db.from(t)…single()` — the error is discarded, and on
// `.single()` that is not the usual harmless shortcut. `.single()` errors
// whenever the row count is anything other than EXACTLY one, so throwing the
// error away collapses three different outcomes into the same `data = null`:
// "no rows", "many rows", and "the query failed".
//
// Live 2026-08-11 (S2, #1357): `PUT /api/deals/[id]` resolved a stage with
// `.eq('slug', …).single()`. Every core slug already exists on FIVE locations,
// so the query matched five rows, PostgREST errored, the error was discarded,
// and `stage` came back null — the caller got a 200 and the deal never moved.
// A silent no-op an integration cannot tell apart from success.
//
// Scoped hard, because a blanket "always destructure error" would hit ~1,000
// call sites that are almost all fine, and even ".single() with a discarded
// error" is 223 (AST-measured across src/ + shared/ at edf60904 — a line-based
// grep puts it near 44, but it cannot see the multi-line chains that are the
// house style here, so trust the rule, not the grep). Pinning the exemption
// below takes it to 14, which is what this landed against. The dangerous shape
// is `.single()` on a filter that is NOT provably unique. Deliberate non-flags:
//   - the chain pins the PRIMARY KEY (`.eq('id', …)`, `.match({ id })`,
//     `.filter('id','eq',…)`) or caps the row count with `.limit(1)`. There
//     `.single()` can only see 0 or 1 rows, so a discarded error means "treat
//     not-found as null" — normally exactly what the caller wants.
//     (`.limit(1)` was added after the baseline scan flagged the
//     anonymous-branding lookup, which is structurally at-most-one.)
//
// K8 (2026-08-11) — the exemption used to accept ANY `<x>_id` column, not just
// `id`, and that edge was documented as the rule's weakest. It has now been
// audited against prod's actual unique indexes, and the honest finding is that
// it was barely load-bearing: of the 209 sites the exemption suppressed, 190
// pinned the real primary key and 3 capped with `.limit(1)`. Only **16** rested
// on the `<x>_id` widening — and of those, 8 were pinned by nothing at all
// (`email_sends.postmark_message_id` ×6, `whatsapp_messages.wa_message_id`,
// `whatsapp_templates.meta_template_id`: all de-facto unique in the live data,
// none carrying an index that says so). The other 8 were pinned, but by
// COMPOSITE uniques the rule cannot see and was not reasoning about
// — `teams (location_id, name)`, `staff_allowances (profile_id, year)`,
// `company_settings (location_id)`, `whatsapp_conversations (location_id,
// wa_phone)`. It was right by luck, on a heuristic that could not have known.
//
// So the widening bought 8 accidental passes and 8 genuine misses. All 16 now
// say `.maybeSingle()` in the source instead — in every one of them 0 rows was
// already the designed answer, guarded by an `if (row)` on the next line — and
// the exemption is narrowed to `id`. That deliberately drops the 1:1-table case
// (`contact_preferences.contact_id` and friends are genuinely unique), because
// the fix there is `.maybeSingle()` too and costs one word. NOT attempted:
// teaching the rule composite uniques by parsing `supabase/migrations` the way
// check:location-scoping derives its tenant tables. It is buildable, but it
// fails in the FALSE-NEGATIVE direction — a mis-parsed `UNIQUE (a, b)` silently
// suppresses a real defect — and after this narrowing the whole class it would
// serve is 8 sites that read better as `.maybeSingle()` anyway. Uniqueness lives
// in the schema; the rule's job is to make the source state its own intent.
//   - `.maybeSingle()`, which returns null for 0 rows WITHOUT an error. It still
//     hides the >1-row and query-failed cases, but that is a much noisier class
//     and a different argument; this rule is about the outcome-collapse that
//     `.single()` uniquely creates.
//   - a result that is not destructured at all (`const res = await …`) — the
//     error is still reachable on the object.
//   - a `...rest` element, which may bind `error`, or a computed key that may
//     spell it. Same precision-first reasoning as the `{...spread}` bail-out in
//     no-untyped-button-in-form: a false positive at ERROR level is worse.
// A non-`id` `<x>_id` column is NOT treated as unique (see the K8 note above).
// `.in()`, `.or()` and a `.filter()` with a non-`eq` operator are NOT treated as
// unique — a list and a disjunction both widen the match rather than pin it.
// `.single()` straight after `.insert()`/`.update()`/`.upsert()` with no id
// filter IS flagged: exactly one row is expected there, so a discarded error is
// a silent FAILED WRITE (that is the glofox-push audit bug).
//
// KNOWN LIMITS: this reads one expression. A chain assembled across statements
// or through a variable (`const q = db.from(t).eq(…); const { data } = await
// q.single()`), a `.single()` consumed by `.then(({ data }) => …)`, or one
// wrapped in a helper the caller destructures, are all invisible. It is a floor,
// not proof. Uniqueness still lives in the SCHEMA, which an AST rule cannot
// read, and it cuts both ways: `.eq('slug', …)` on `race_events` is at-most-one
// because of a global unique index (mig 451), and the rule flags it anyway; so
// is any chain matching a composite unique (`.eq('location_id').eq('name')` on
// `teams`). Those are ACCEPTED false positives now — the fix in every audited
// instance was `.maybeSingle()`, which is the better source anyway. Where 0 rows
// is a legitimate answer that is the fix; where it is not, destructure `error`.
const UNIQUE_HINT_FILTERS = new Set(['eq', 'match', 'filter', 'limit'])

// The PRIMARY KEY column, and only it. Every table in this schema keys on `id`,
// so `.eq('id', …)` is the one filter whose at-most-one-row property an AST can
// assert without reading the schema. Narrowed from "`id` or anything ending
// `_id`" by the K8 audit — see the note above for the measurement.
function isIdLikeColumn(name) {
  return name === 'id'
}

function literalString(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null
}

// Does THIS call pin an id-like column to a single value?
function callPinsIdColumn(call) {
  const name = call.callee.property && call.callee.property.name
  if (!UNIQUE_HINT_FILTERS.has(name)) return false
  const args = call.arguments || []
  if (name === 'eq') return isIdLikeColumn(literalString(args[0]))
  // .limit(1) caps the row count structurally — PostgREST can return at most one
  // row, so .single() can only ever error on 0 rows. Same shape as a pk filter.
  if (name === 'limit') return args[0] && args[0].type === 'Literal' && args[0].value === 1
  // .filter(column, operator, value) — only the eq operator pins a row.
  if (name === 'filter') return literalString(args[1]) === 'eq' && isIdLikeColumn(literalString(args[0]))
  // .match({ id, contact_id }) — an object of equality filters.
  if (name === 'match') {
    const obj = args[0]
    if (!obj || obj.type !== 'ObjectExpression') return false
    return (obj.properties || []).some((p) => {
      if (p.type !== 'Property' || p.computed) return false
      const key = p.key.type === 'Identifier' ? p.key.name : literalString(p.key)
      return isIdLikeColumn(key)
    })
  }
  return false
}

// Walk DOWN the chain; true if any link pins an id-like column.
function chainPinsIdColumn(node) {
  let cur = node
  while (cur) {
    if (cur.type === 'CallExpression') {
      const c = cur.callee
      if (c && c.type === 'MemberExpression') {
        if (callPinsIdColumn(cur)) return true
        cur = c.object
      } else {
        cur = null
      }
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object
    } else {
      cur = null
    }
  }
  return false
}

// The ObjectPattern this expression's result is destructured into, if any.
function destructuringTarget(node, ancestors) {
  let idx = ancestors.length - 1
  let child = node
  let parent = ancestors[idx]
  if (parent && parent.type === 'AwaitExpression' && parent.argument === child) {
    child = parent
    parent = ancestors[--idx]
  }
  if (!parent) return null
  if (parent.type === 'VariableDeclarator' && parent.init === child) return parent.id
  if (parent.type === 'AssignmentExpression' && parent.right === child) return parent.left
  return null
}

const noDiscardedSingleError = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow destructuring a .single() result without `error` unless the chain pins an id-like column. .single() errors on any row count other than exactly one, so a discarded error collapses "no rows", "many rows" and "query failed" into data = null.',
    },
    schema: [],
    messages: {
      discarded:
        '.single() errors whenever the row count is not exactly 1, so discarding `error` collapses "no rows", "many rows" and "the query failed" into the same `data = null` — the caller cannot tell a silent no-op from success (S2/#1357: a stage slug matching five locations). This chain is not pinned to the primary key (`.eq(\'id\', …)`) or capped with `.limit(1)`, so >1 row is reachable: destructure `error` and handle it, or use .maybeSingle() if 0 rows is a legitimate answer. If the filter IS unique in the schema (a composite unique, or a unique non-`id` column), the rule cannot see that — say it with .maybeSingle() and a comment rather than a disable.',
    },
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.name="single"]'(node) {
        if (!chainRootIsSupabase(node.callee.object)) return
        // Pinned to an id-like column → at most one row is structural, and a
        // discarded error there reads as "not found → null".
        if (chainPinsIdColumn(node.callee.object)) return
        const target = destructuringTarget(node, context.sourceCode.getAncestors(node))
        if (!target || target.type !== 'ObjectPattern') return
        for (const prop of target.properties || []) {
          // A rest element may bind `error`; a computed key may spell it.
          if (prop.type !== 'Property') return
          if (prop.computed) return
          const key = prop.key.type === 'Identifier' ? prop.key.name : literalString(prop.key)
          if (key === 'error') return
        }
        context.report({ node, messageId: 'discarded' })
      },
    }
  },
}

// Plain accent TEXT at a ramp too low to read on a light card. The sibling rule
// no-low-contrast-chip only fires on a bg+text PAIRING in the same string, so a
// bare `text-emerald-400` on a `bg-un1t-surface` card — no chip background at
// all — is invisible to it. That gap is why 52 of them shipped across the six
// Communications editors (CampaignEditor, SMSBroadcastEditor, CampaignDetail,
// WABroadcastEditor, WATemplateEditor, TemplateEditor) and why COMMSLAYOUT.5 had
// to police the rest of that tree with a bespoke file-scanning vitest instead of
// a lint rule. This rule subsumes that scan.
//
// The palette is a LIGHT theme (its token names were inverted — `un1t-black`
// held white — until UI-FOUND.1 renamed them to intent names; see
// no-dead-un1t-token below), so the dark-theme instinct of "accent at
// -300/-400" lands washed-out grey on white. CLAUDE.md settles it: status/accent text on light cards uses the -700
// ramp. -500 is included because it is the same mistake one stop up and the
// bright hues (yellow/lime/green/cyan) fail AA badly there.
//
// Deliberate non-flags:
//   - `un1t-*` tokens — intent-named, they carry their own light/dark semantics.
//   - a `dark:` variant — that prefix is by definition a dark-surface ramp.
//   - a string that ALSO names an explicit dark background (`bg-black`, or an
//     arbitrary near-black `bg-[#0..]`). That is the dark panel embedded in a
//     light page: the HTML-source textareas in CampaignEditor/TemplateEditor are
//     `bg-black text-green-400`, which is correct and must not be "fixed" into
//     invisibility. Note `bg-*-900/950` is deliberately NOT an escape here —
//     no-low-contrast-chip already owns that pairing and calls it the bug.
//   - `bg-*` / `border-*` / `ring-*` at a low ramp: only `text-` is judged.
//
// KNOWN LIMIT — this rule cannot see the surface. It reads a class string, not a
// rendered DOM, so it cannot tell `text-cyan-400` on white from the same class
// on a black panel whose background is set by a PARENT element, a sibling
// string, or a CSS variable. Two things compensate, and neither is proof:
//   1. SCOPE. It is armed per-path in eslint.guardrails.config.mjs, only on
//      directories whose surfaces have actually been surveyed as light. Adding a
//      cleaned area later is one line in that list. It is deliberately NOT
//      repo-wide: ~500 low-ramp sites exist outside the armed paths and an
//      unknown share of them are correct dark-surface idiom.
//   2. The same-string `bg-black` escape above, which only works when the dark
//      background is written on the SAME element. A dark island whose background
//      lives on a parent will false-positive — the fix is to move the background
//      onto the element, not to disable the rule.
// It is also a RAMP heuristic, not a contrast calculation: Tailwind's ramps are
// not iso-luminant, so `text-yellow-700` passes this rule and is still marginal
// on white, while `text-slate-500` is flagged and is merely mediocre.
const ACCENT_PALETTES =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone'
// A `text-<palette>-300|400|500` utility, with any variant prefixes in front of
// it (hover:, focus:, md:, group-hover:, …). The leading boundary keeps us off
// substrings of longer identifiers.
const LOW_RAMP_ACCENT_TEXT = new RegExp(
  `(?:^|[\\s"'\`:])((?:[a-z-]+:)*)text-(?:${ACCENT_PALETTES})-(?:300|400|500)\\b`,
)
// An explicitly dark background on the SAME element — the dark-panel escape.
const DARK_SURFACE_BG = /\bbg-black\b|\bbg-\[#0[0-9a-fA-F]{2,5}\]/

function accentTextViolation(str) {
  if (typeof str !== 'string' || !str.includes('text-')) return false
  if (DARK_SURFACE_BG.test(str)) return false
  const hit = str.match(LOW_RAMP_ACCENT_TEXT)
  if (!hit) return false
  // `dark:text-slate-400` is a dark-mode ramp by construction.
  if (/(?:^|:)dark:$/.test(hit[1])) return false
  return true
}

const noLowContrastAccentText = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow accent text at the -300/-400/-500 ramp on light surfaces. Complements no-low-contrast-chip, which only sees a bg+text chip pairing and is blind to plain accent text. Armed per-path (surveyed-light directories only); does not know what surface a class renders on beyond a same-string bg-black escape.',
    },
    schema: [],
    messages: {
      lowRamp:
        "Accent text on a light card needs the -700 ramp (CLAUDE.md: the palette is a light theme with inverted token names, so text-<colour>-300/400/500 is the dark-theme recipe and reads as washed-out grey). Change the ramp, keep the hue — red still means destructive, amber still means warning. If this genuinely sits on a dark panel inside a light page, put the dark background on the SAME element (`bg-black …`), which is how the HTML-source textareas stay legal.",
    },
  },
  create(context) {
    function check(node, value) {
      if (accentTextViolation(value)) context.report({ node, messageId: 'lowRamp' })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateLiteral(node) {
        // Join the static parts, same as no-low-contrast-chip: a `bg-black` and
        // the text class sitting either side of a `${…}` still pair up.
        const joined = (node.quasis || [])
          .map((q) => (q.value && q.value.cooked) || '')
          .join(' ')
        check(node, joined)
      },
    }
  },
}

// A un1t-* colour token that was RENAMED AWAY by UI-FOUND.1 (and mirrored in
// mobile by MOB-UI.1): black→bg, dark→surface, gray→border, mid→muted,
// light→subtle, white→text. The old names are not aliases — they were deleted
// from both tailwind configs.
//
// This is a different failure from the two contrast rules above. Those flag a
// colour that is WRONG; this one flags a colour that does not EXIST. Tailwind
// does not error on an unknown token, it simply emits no css, so the utility is
// inert and the element silently inherits from its parent. Nothing warns: not
// the build, not the type system, not a test. 142 sites in src/ and 3 in
// mobile/ survived the rename that way for weeks, and the way it finally
// surfaced was an operator asking what was meant to be inside the black box on
// /offer-sales (2026-08-19) — the "Mark fulfilled" label carried
// `text-un1t-black`, which after the rename set no colour at all, so white-on-
// dark became near-black-on-dark.
//
// Fixable: unlike the contrast rules (where the right ramp is a judgement call)
// the mapping here is exact, so `--fix` is the migration.
//
// The trailing `(?![\w-])` boundary is what lets this run at ERROR repo-wide —
// `un1t-dark-logo.png` and `un1t-lightbox` merely start with a dead name and
// are not tokens. A trailing `/40` opacity modifier IS matched: the modifier is
// not part of the token name. Only string literals and template chunks are
// inspected, never comments — the configs and this file legitimately name the
// old tokens while documenting the rename.
const DEAD_UN1T_TOKENS = {
  black: 'bg',
  dark: 'surface',
  gray: 'border',
  mid: 'muted',
  light: 'subtle',
  white: 'text',
}
const DEAD_UN1T_TOKEN = /un1t-(black|dark|gray|mid|light|white)(?![\w-])/g

const noDeadUn1tToken = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        'Disallow un1t-* colour tokens that UI-FOUND.1 renamed away (black/dark/gray/mid/light/white). They are absent from both tailwind configs, so Tailwind emits no css and the element silently inherits — an invisible failure, not a wrong colour.',
    },
    schema: [],
    messages: {
      deadToken:
        '`un1t-{{old}}` no longer exists — UI-FOUND.1 renamed it to `un1t-{{replacement}}` (mobile followed in MOB-UI.1). Tailwind emits NO css for an unknown token, so this class is inert and the element inherits instead: that is how the /offer-sales "Mark fulfilled" button shipped as an unreadable black box. Use `un1t-{{replacement}}`, or run `npm run check:guardrails -- --fix`.',
    },
  },
  create(context) {
    const source = context.sourceCode || context.getSourceCode()
    function check(node) {
      const text = source.getText(node)
      for (const match of text.matchAll(DEAD_UN1T_TOKEN)) {
        const old = match[1]
        const replacement = DEAD_UN1T_TOKENS[old]
        const start = node.range[0] + match.index
        const range = [start, start + match[0].length]
        context.report({
          node,
          messageId: 'deadToken',
          data: { old, replacement },
          fix: (fixer) => fixer.replaceTextRange(range, `un1t-${replacement}`),
        })
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node)
      },
      // Per CHUNK, not per template: fixing the whole literal would have to
      // reproduce the ${…} expressions, and the chunk ranges are exact.
      TemplateElement(node) {
        check(node)
      },
    }
  },
}

// HUBDOOR.3 — `expect(page()).rejects.toThrow('NEXT_REDIRECT:/x')` is a
// SUBSTRING match, and every redirect target in this app is a path that
// begins with '/'. So `toThrow('NEXT_REDIRECT:/')` — the natural way to
// assert "bounced to home" — passes against EVERY redirect the page could
// possibly throw, and the longer ones are prefixes of each other
// ('/schedule' passes on '/schedule/expenses', '/settings' on
// '/settings/scoring', '/events' on '/events/[id]/checkin'). The assertion
// still goes green after the behaviour it pins has changed, which is worse
// than having no assertion at all: it reads as coverage.
//
// It was not hypothetical. Every hub-index suite asserted its fallback this
// way, and the Operations one had been passing on a redirect to
// '/admin/fleet' — `fleet_restart` defaults ON for every role and the
// fixture never denied it, so the suite that existed to prove "a user with
// no Operations permission lands on '/'" was in fact proving nothing. All
// 83 sites are now anchored regexes; this rule is what stops the 84th.
//
// Deliberately narrow: only literals beginning with NEXT_REDIRECT. A plain
// `toThrow('Not found')` is a normal, useful substring assertion — it is the
// prefix-shaped path namespace that makes THIS one vacuous.
const REDIRECT_THROW_MATCHERS = new Set(['toThrow', 'toThrowError'])

const noSubstringRedirectAssertion = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow toThrow('NEXT_REDIRECT:…') with a string argument — toThrow(string) is a substring match, so the assertion passes against any redirect target that has the asserted one as a prefix.",
    },
    schema: [],
    messages: {
      substring:
        "toThrow(string) is a SUBSTRING match, so this passes against any redirect whose target starts with '{{target}}' — including '/' matching every redirect there is. Anchor it: toThrow(/^NEXT_REDIRECT:{{escaped}}$/).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee?.type !== 'MemberExpression' || callee.computed) return
        if (!REDIRECT_THROW_MATCHERS.has(callee.property?.name)) return
        const arg = node.arguments?.[0]
        let value = null
        if (arg?.type === 'Literal' && typeof arg.value === 'string') value = arg.value
        else if (arg?.type === 'TemplateLiteral' && arg.expressions.length === 0) {
          value = arg.quasis[0]?.value?.cooked ?? null
        }
        if (value == null || !value.startsWith('NEXT_REDIRECT')) return
        const target = value.slice('NEXT_REDIRECT:'.length)
        context.report({
          node: arg,
          messageId: 'substring',
          data: { target, escaped: target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') },
        })
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
    'no-low-contrast-accent-text': noLowContrastAccentText,
    'no-dead-un1t-token': noDeadUn1tToken,
    'no-unescaped-ilike-pattern': noUnescapedIlikePattern,
    'no-untyped-button-in-form': noUntypedButtonInForm,
    'no-discarded-single-error': noDiscardedSingleError,
    'no-substring-redirect-assertion': noSubstringRedirectAssertion,
  },
}
