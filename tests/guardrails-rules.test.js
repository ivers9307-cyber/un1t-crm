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
