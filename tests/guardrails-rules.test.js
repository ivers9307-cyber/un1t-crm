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
