import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import plugin from '../eslint-rules/index.mjs'

// Wire ESLint's RuleTester to vitest's test hooks.
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

// JSX-enabled tester — the button-type rule walks a JSX ancestor chain, so its
// cases need the same parserOptions the guardrails config gives src/**.
const jsxRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-catch-on-supabase-builder', plugin.rules['no-catch-on-supabase-builder'], {
  valid: [
    'async () => { await db.from("x").select("*") }',
    // .then() on a builder is fine (it fires + returns a real Promise)
    'db.from("x").insert(y).then(() => {}, () => {})',
    // .then(...).catch(...) — the .then() returns a real Promise that owns .catch
    'db.from("x").update(y).then(ok).catch(err)',
    // not a supabase chain
    'somePromise.catch(() => {})',
    'fetch(u).then(r => r.json()).catch(() => {})',
    'db.from("x").select("*")',
    // storage ops return real Promises — .catch/.finally on them is fine
    'async () => { await db.storage.from("b").remove([p]).catch(() => {}) }',
    'db.storage.from("b").upload(p, f).catch(() => {})',
  ],
  invalid: [
    { code: 'db.rpc("f", {}).catch(() => {})', errors: [{ messageId: 'noCatch' }] },
    { code: 'db.from("x").update(y).eq("id", 1).catch(() => {})', errors: [{ messageId: 'noCatch' }] },
    { code: 'async () => { await db.from("x").insert(y).finally(() => {}) }', errors: [{ messageId: 'noCatch' }] },
  ],
})

ruleTester.run('no-uncapped-supabase-limit', plugin.rules['no-uncapped-supabase-limit'], {
  valid: [
    'db.from("x").select("*").limit(50)',
    'db.from("x").select("*").order("id").range(0, 1999)',
    // .range present → treated as paginated
    'db.from("x").select("*").range(0, 4999).limit(5000)',
    // not a supabase chain
    'somethingElse.limit(5000)',
    // under the 1000 threshold
    'db.from("x").select("*").limit(999)',
  ],
  invalid: [
    { code: 'db.from("x").select("*").limit(5000)', errors: [{ messageId: 'cap' }] },
    { code: 'async () => { await db.from("x").select("c").eq("loc", l).limit(20000) }', errors: [{ messageId: 'cap' }] },
    { code: 'db.from("x").select("*").limit(1000)', errors: [{ messageId: 'cap' }] },
  ],
})

ruleTester.run('no-zulu-template-date', plugin.rules['no-zulu-template-date'], {
  valid: [
    'new Date("2026-06-25T10:00:00Z")', // literal UTC instant, not interpolated wall-clock
    'new Date(`${d}T${t}`)', // no trailing Z
    'new Date(`${dateStr}T00:00:00Z`)', // literal midnight — UTC date math (addDaysISO), legit
    'new Date(`${d}T12:00:00Z`)', // literal noon — date-label anchor, legit
    'new Date(ms)',
    'new Date()',
  ],
  invalid: [
    { code: 'new Date(`${d}T${t}Z`)', errors: [{ messageId: 'z' }] },
    { code: 'new Date(`${date}T${hh}:${mm}Z`)', errors: [{ messageId: 'z' }] },
  ],
})

ruleTester.run('no-utc-today', plugin.rules['no-utc-today'], {
  valid: [
    'new Date().toISOString()', // bare UTC timestamp — correct
    'someDate.toISOString().slice(0, 10)', // a specific date, not "now"
    'new Date(x).toISOString().slice(0, 10)', // new Date(arg), not "now"
    'dublinTodayStr()',
  ],
  invalid: [
    { code: 'new Date().toISOString().slice(0, 10)', errors: [{ messageId: 'utcToday' }] },
    { code: "new Date().toISOString().split('T')[0]", errors: [{ messageId: 'utcToday' }] },
  ],
})

ruleTester.run('no-low-contrast-chip', plugin.rules['no-low-contrast-chip'], {
  valid: [
    // the light chip idiom — -700 ramp on a tint
    '"bg-emerald-500/10 text-emerald-700"',
    '"bg-red-500/10 rounded text-red-700"',
    // -400 text with NO chip bg in the same string (icons on white, muted text)
    '"text-gray-400"',
    // dark bg with light-enough text is a dark-surface idiom; only flagged with low ramps
    '"bg-gray-900 text-white"',
    // recipe split across separate strings (ternary halves) — precision-first, not flagged
    '"bg-green-500/20" + (x ? "text-green-700" : "text-white")',
    // solid -500 bg with white text (buttons) — fine
    '"bg-red-500 text-white"',
  ],
  invalid: [
    // THE credits pill (2026-07-03 operator report): dark chip on light theme
    { code: '"bg-green-900/40 rounded text-green-400"', errors: [{ messageId: 'darkChip' }] },
    { code: '"text-red-400 bg-red-950/30 border border-red-900/50"', errors: [{ messageId: 'darkChip' }] },
    // washed-out tint chips
    { code: '"bg-amber-500/20 text-amber-400"', errors: [{ messageId: 'lowContrast' }] },
    { code: '"bg-purple-500/10 text-purple-300"', errors: [{ messageId: 'lowContrast' }] },
    { code: '"bg-red-50 text-red-400"', errors: [{ messageId: 'lowContrast' }] },
    // template literal with both halves in static text
    { code: 'const c = `px-2 bg-teal-500/20 ${x} text-teal-400`', errors: [{ messageId: 'lowContrast' }] },
  ],
})

// COMMSLAYOUT.6 — the plain-accent-text half of the same problem. This rule
// subsumes the file-scanning tests/comms-light-theme-contrast.test.js that used
// to police the Communications tree (deleted with this rule, so one mechanism
// enforces this rather than two that can drift apart).
ruleTester.run('no-low-contrast-accent-text', plugin.rules['no-low-contrast-accent-text'], {
  valid: [
    // the light-theme ramp
    '"text-emerald-700"',
    '"flex items-center gap-1 text-xs text-red-700"',
    // -600 is a legitimate muted grey on white (email/WhatsApp preview mocks)
    '"text-xs text-gray-600 mt-2"',
    // un1t-* tokens are intent-named and carry their own semantics
    '"text-un1t-subtle hover:text-un1t-text"',
    '"text-un1t-muted"',
    // a low ramp used for something that is not TEXT
    '"bg-emerald-500/10 border-red-400/40 ring-blue-300"',
    // the dark panel inside a light page: the HTML-source textareas
    '"flex-1 w-full bg-black text-green-400 font-mono text-sm p-5"',
    '"bg-[#0b0b0b] text-slate-400"',
    // an explicit dark-mode variant is a dark-surface ramp by construction
    '"dark:text-slate-400"',
    // not a Tailwind colour utility — a substring of a longer identifier
    '"context-red-400"',
    // -600/-700 hover pair
    '"text-red-700 hover:text-red-800"',
  ],
  invalid: [
    // the shipped CampaignEditor / SMSBroadcastEditor shapes
    { code: '"inline-flex items-center gap-1 text-xs text-emerald-400"', errors: [{ messageId: 'lowRamp' }] },
    { code: '"text-2xl font-bold mt-1 text-red-400"', errors: [{ messageId: 'lowRamp' }] },
    // -500 is the same mistake one stop up
    { code: '"text-[11px] text-amber-500"', errors: [{ messageId: 'lowRamp' }] },
    { code: '"text-sm text-blue-500"', errors: [{ messageId: 'lowRamp' }] },
    // -300 too
    { code: '"text-sm text-red-400 hover:text-red-300"', errors: [{ messageId: 'lowRamp' }] },
    // a variant prefix does not exempt it
    { code: '"text-un1t-muted hover:text-red-400 p-1"', errors: [{ messageId: 'lowRamp' }] },
    { code: '"md:text-cyan-400"', errors: [{ messageId: 'lowRamp' }] },
    // the class living in a config map rather than on JSX
    { code: "const cfg = { color: 'text-orange-400' }", errors: [{ messageId: 'lowRamp' }] },
    // template literal — the static half is judged
    { code: 'const c = `flex ${x} text-cyan-400 text-xs`', errors: [{ messageId: 'lowRamp' }] },
    // neutrals count: gray-400 on white is ~2.8:1
    { code: '"p-12 text-center text-gray-400"', errors: [{ messageId: 'lowRamp' }] },
  ],
})

jsxRuleTester.run('no-untyped-button-in-form', plugin.rules['no-untyped-button-in-form'], {
  valid: [
    // no <form> ancestor in this file — outside a form the default is inert
    'const A = () => <div><button onClick={x}>Go</button></div>',
    // explicit literal types
    'const A = () => <form><button type="button" onClick={x}>X</button></form>',
    'const A = () => <form><button type="submit">Save</button></form>',
    'const A = () => <form><button type="reset">Reset</button></form>',
    // dynamic type — still explicit; we cannot judge the value
    'const A = () => <form><button type={t}>X</button></form>',
    // a spread may carry the type — false positives on shared primitives are worse
    'const A = () => <form><button {...props}>X</button></form>',
    // uppercase component — the repo primitive sets its own type
    'const A = () => <form><Button onClick={x}>X</Button></form>',
    // a form SIBLING, not an ancestor
    'const A = () => <div><form><input /></form><button onClick={x}>X</button></div>',
  ],
  invalid: [
    // nested several levels deep — proves the ancestor walk, not a direct-child check
    {
      code: 'const A = () => <form onSubmit={s}><div><fieldset><span><button onClick={x}>X</button></span></fieldset></div></form>',
      errors: [{ messageId: 'untyped' }],
    },
    // direct child
    { code: 'const A = () => <form><button onClick={x}>X</button></form>', errors: [{ messageId: 'untyped' }] },
    // two in one form
    {
      code: 'const A = () => <form><div><button onClick={a}>A</button><button onClick={b}>B</button></div></form>',
      errors: [{ messageId: 'untyped' }, { messageId: 'untyped' }],
    },
  ],
})

ruleTester.run('no-discarded-single-error', plugin.rules['no-discarded-single-error'], {
  valid: [
    // the error IS destructured — the whole point
    'async () => { const { data, error } = await db.from("x").select("*").eq("slug", s).single() }',
    // …including renamed
    'async () => { const { data: stage, error: stageErr } = await db.from("p").select("id").eq("slug", s).single() }',
    // primary-key lookup — .single() can only see 0 or 1 rows, so a discarded
    // error reads as "not found → null", which is normally the intent
    'async () => { const { data } = await db.from("x").select("*").eq("id", id).single() }',
    // foreign-key lookup — same at-most-one-row shape
    'async () => { const { data } = await db.from("x").select("*").eq("contact_id", cid).single() }',
    // .match({ id }) is .eq("id", …) spelled as an object
    'async () => { const { data } = await db.from("x").select("*").match({ id }).single() }',
    'async () => { const { data } = await db.from("x").select("*").match({ contact_id: c, kind: k }).single() }',
    // .filter(col, "eq", v) is the long form of .eq
    'async () => { const { data } = await db.from("x").select("*").filter("id", "eq", v).single() }',
    // .limit(1) caps the row count structurally — same at-most-one shape as a
    // primary-key filter, so .single() can only ever error on 0 rows
    'async () => { const { data } = await db.from("y").select("*").limit(1).single() }',
    // a write pinned to one row by id — same structural at-most-one
    'async () => { const { data } = await db.from("x").update(u).eq("id", id).select().single() }',
    // .maybeSingle() does not error on 0 rows — a different, much noisier class
    'async () => { const { data } = await db.from("x").select("*").eq("slug", s).maybeSingle() }',
    // not destructured — the error is still reachable on the result object
    'async () => { const res = await db.from("x").select("*").eq("slug", s).single() }',
    // a rest element may carry `error` (same reasoning as the {...spread} in
    // no-untyped-button-in-form)
    'async () => { const { data, ...rest } = await db.from("x").select("*").eq("slug", s).single() }',
    // a computed key may be "error" — unprovable, so we stay silent
    'async () => { const { [k]: v } = await db.from("x").select("*").eq("slug", s).single() }',
    // not a supabase builder chain
    'async () => { const { data } = await someClient.query(q).single() }',
  ],
  invalid: [
    // THE S2 bug (#1357): every core slug exists on five locations, so this
    // matched 5 rows, errored, and the caller got null + a 200
    {
      code: 'async () => { const { data: stage } = await db.from("pipeline_stages").select("id").eq("slug", s).single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // a fire-and-forget audit insert — a FAILED WRITE is silent
    {
      code: 'async () => { const { data } = await db.from("glofox_push_events").insert(row).select("id").single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // .in() takes a LIST — it implies nothing about uniqueness
    {
      code: 'async () => { const { data } = await db.from("x").select("*").in("id", ids).single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // .or() is a disjunction — it widens, it does not pin
    {
      code: 'async () => { const { data } = await db.from("x").select("*").or("id.eq.1,id.eq.2").single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // a non-id equality: emails duplicate, and .single() errors when they do
    {
      code: 'async () => { const { data } = await db.from("contacts").select("id").eq("email", e).single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // rpc returning a set
    { code: 'async () => { const { data } = await db.rpc("f", a).single() }', errors: [{ messageId: 'discarded' }] },
    // assignment form, not a declaration
    {
      code: 'async () => { let data; ({ data } = await db.from("x").select("*").eq("slug", s).single()) }',
      errors: [{ messageId: 'discarded' }],
    },
    // .filter with a non-eq operator does not pin a row
    {
      code: 'async () => { const { data } = await db.from("x").select("*").filter("id", "in", v).single() }',
      errors: [{ messageId: 'discarded' }],
    },
    // .limit(2) leaves >1 row reachable — only limit(1) caps it
    {
      code: 'async () => { const { data } = await db.from("x").select("*").limit(2).single() }',
      errors: [{ messageId: 'discarded' }],
    },
  ],
})
