// CONTACTREADSCOPE.1 guard (mig 690). A signed-in staff session reads a
// studio's contacts directly only while holding Contacts (web OR phone) at
// that studio; members read their own row. Pinned here (the client half):
//
//  (a) CLIENT CODE (shared/, mobile/, and src/ files that run with a user
//      session): every direct .from('contacts') read and every contacts embed
//      is on the census below, with the reason it is safe. A new one fails
//      until someone decides: own row by user_id, a screen gated by Contacts,
//      service-role-only code, or an embed whose screen renders a fallback
//      when the embed is null. Anything that needs contact DATA for someone
//      without Contacts goes through a route (the Studio dashboard's numbers:
//      /api/dashboard/studio-contacts, 1a).
//  (b) The phone-called shared fetchers never read contacts, and the phone
//      never imports the server-only shared readers.
// The migration half lives in tests/contacts-read-scope-migration-guard.test.js
// (1b, #1915): (c) later migrations keep contacts_select on the helper, never
// back on membership; (d) the helper's inline role defaults equal
// DEFAULT_WEB/MOBILE_PERMISSIONS_BY_ROLE.contacts.
//
// A floor, not a proof: a select string built at runtime or a builder held
// in a variable is invisible; the migration and its replay are the fence.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { stripComments, isClientFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientFile(readFileSync(f, 'utf8')))
  return [...phone, ...browser]
}

const FROM = /\.from\(\s*['"`]contacts['"`]\s*\)/g
const REALTIME = /\btable\s*:\s*['"`]contacts['"`]/g
// An embed inside a select string: 'contact:contacts(id)', 'contacts!contact_id(x)',
// 'contacts:contact_id (id)', 'contact_id(name)'.
const EMBED = /(?:\bcontacts\s*(?:!\s*\w+\s*)?\(|\bcontact_id\s*\()/g

/** Every string and template-literal text in the file, from the TypeScript parser (an apostrophe in JSX text cannot pair up). */
function stringTexts(text) {
  const sf = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out = []
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text)
      for (const s of n.templateSpans) out.push(s.literal.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** { from, embed, realtime } counts of contacts reads in one file's code. */
export function contactReads(text) {
  const code = stripComments(text)
  const embed = stringTexts(text).reduce((n, s) => n + [...s.matchAll(EMBED)].length, 0)
  return { from: [...code.matchAll(FROM)].length, embed, realtime: [...code.matchAll(REALTIME)].length }
}

/** file → { from, embed, why }. Counted on origin/main 449925fc + 1a (2 Oct 2026; the same counts as 4f1853d8, 1 Oct). */
export const CONTACT_READERS = Object.freeze({
  'mobile/lib/contacts-api.js': { from: 2, embed: 0, why: 'the Contacts directory and detail; the tab is gated by phone Contacts, and mig 690 admits web OR phone Contacts' },
  'mobile/lib/identity-context.jsx': { from: 1, embed: 0, why: 'own contact row by user_id (member branch of contacts_select)' },
  'mobile/lib/member/contact-context.jsx': { from: 2, embed: 0, why: 'own contact row by user_id (member branch)' },
  'shared/dashboard-data.js': { from: 6, embed: 1, why: 'fetchStudioContactCounts x2, fetchFunnelCounts x3, fetchAdsSummary x1: service-role only (the route, the web Business page, /api/dashboard/business; (b) pins that the phone never imports them). Embed: the Today WhatsApp card, which only sums unread_count' },
  'shared/studio-kpis.js': { from: 5, embed: 1, why: 'service-role only (web Studio page, labour-month-data); (b) pins that the phone never imports the module' },
  'mobile/lib/whatsapp-api.js': { from: 0, embed: 1, why: 'inbox list; the row falls back to wa_profile_name / wa_phone when the embed is null' },
  'mobile/lib/pipeline-api.js': { from: 0, embed: 2, why: 'board + deal detail; "Unknown" and no contact buttons when the embed is null' },
  'mobile/lib/tasks-api.js': { from: 0, embed: 1, why: 'my tasks; the contact line is hidden when the embed is null' },
  'mobile/lib/bookings-api.js': { from: 0, embed: 1, why: 'upcoming bookings; customer_name is shown first' },
  'src/components/TasksPage.jsx': { from: 0, embed: 1, why: 'the row returned after creating a task; the contact chip is hidden when the embed is null' },
  // Two hits that are not session reads (measured with this detector on 4f1853d8):
  'src/lib/customer-auth.js': { from: 1, embed: 0, why: 'service role: the anon-key client only verifies the Bearer JWT; the contacts read (resolveCustomerContact) uses createServerClient()' },
  'src/components/host/HostEmails.jsx': { from: 0, embed: 1, why: 'not a query: the display text "… contacts (where emailable)" in a template literal' },
})

describe('(a) every client read of contacts is on the census (CONTACTREADSCOPE.1)', () => {
  const files = clientFiles()
  const found = {}
  for (const f of files) {
    const r = contactReads(readFileSync(f, 'utf8'))
    if (r.from || r.embed || r.realtime) found[rel(f)] = r
  }

  it('scans the files it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toEqual(expect.arrayContaining(['mobile/lib/contacts-api.js', 'shared/dashboard-data.js', 'src/components/TasksPage.jsx']))
    expect(names.length).toBeGreaterThan(300)
  })

  it('no realtime subscription on contacts', () => {
    expect(Object.entries(found).filter(([, r]) => r.realtime).map(([f]) => f)).toEqual([])
  })

  it('the reads are exactly the census', () => {
    const actual = Object.fromEntries(Object.entries(found).map(([f, r]) => [f, { from: r.from, embed: r.embed }]))
    const expected = Object.fromEntries(Object.entries(CONTACT_READERS).map(([f, r]) => [f, { from: r.from, embed: r.embed }]))
    expect(actual, 'a new client read of contacts: decide (own row / Contacts-gated screen / service-role only / null-safe embed) and add it with its reason, or move it to a route').toEqual(expected)
  })

  it('the detector sees every spelling', () => {
    const r = contactReads(`
      await supabase.from('contacts').select('id')
      const S = \`id, contact:contacts(id, name),
        deal:deals(contacts!contact_id(name)), x:contacts:contact_id (id)\`
      supabase.channel('c').on('postgres_changes', { table: 'contacts' })
      // supabase.from('contacts') in a comment is not a read
    `)
    expect(r).toEqual({ from: 1, embed: 3, realtime: 1 })
  })
})

describe('(b) the phone never reads contacts through the shared fetchers', () => {
  const src = readFileSync(path.join(ROOT, 'shared/dashboard-data.js'), 'utf8')
  const body = (name) => {
    const start = src.indexOf(`export async function ${name}(`)
    expect(start, `${name} not found`).toBeGreaterThan(-1)
    const next = src.indexOf('\nexport ', start + 1)
    return stripComments(src.slice(start, next === -1 ? undefined : next))
  }

  it('fetchStudioDashboardData and fetchPersonalDashboardData (the phone calls both) have no direct contacts read', () => {
    expect(contactReads(body('fetchStudioDashboardData')).from).toBe(0)
    expect(contactReads(body('fetchPersonalDashboardData')).from).toBe(0)
  })

  it('mobile/ never imports the server-only readers', () => {
    const offenders = walk(path.join(ROOT, 'mobile')).filter((f) => importsServerOnlyReader(stripComments(readFileSync(f, 'utf8')))).map(rel)
    expect(offenders).toEqual([])
  })

  // REVIEWNITS.1 (D5): the named-import regex missed `import * as dd` then
  // `dd.fetchStudioContactCounts(…)`, a dynamic import or require, a relative
  // specifier and a re-export. The rule is now by file: one that reaches
  // shared/dashboard-data in any form names none of the three readers (the
  // phone's own route caller is fetchStudioContactCountsFromRoute), and none
  // reaches shared/studio-kpis at all.
  it('the import detector sees every spelling', () => {
    const SPECS = ["'shared/dashboard-data'", '"shared/dashboard-data.js"', "'../../shared/dashboard-data'"]
    for (const spec of SPECS) {
      for (const code of [
        `import { fetchStudioDashboardData, fetchStudioContactCounts } from ${spec}`,
        `import * as dd from ${spec}\nconst r = await dd.fetchFunnelCounts(db, loc)`,
        `import * as dd from ${spec}\nconst f = dd['fetchAdsSummary']`,
        `const dd = await import(${spec})\nawait dd?.fetchStudioContactCounts(db, loc)`,
        `const { fetchAdsSummary: ads } = require(${spec})`,
        `export { fetchFunnelCounts } from ${spec}`,
        `import(${spec}).then((m) => m.fetchStudioContactCounts(db, loc))`,
      ]) expect(importsServerOnlyReader(code), code).toBe(true)
    }
    expect(importsServerOnlyReader("import { x } from 'shared/studio-kpis'")).toBe(true)
    expect(importsServerOnlyReader("const k = await import('../../shared/studio-kpis.js')")).toBe(true)
    for (const code of [
      "import { fetchStudioDashboardData } from 'shared/dashboard-data'\nexport async function fetchStudioContactCountsFromRoute() {}",
      "export async function fetchStudioContactCounts() {} // no shared import: a local name",
      "import { fetchFunnelCounts } from './funnel'",
    ]) expect(importsServerOnlyReader(code), code).toBe(false)
  })
})

const DASHBOARD_DATA = String.raw`['"\x60](?:shared|(?:\.\.?\/)+shared)\/dashboard-data(?:\.js)?['"\x60]`
const STUDIO_KPIS = String.raw`['"\x60](?:shared|(?:\.\.?\/)+shared)\/studio-kpis(?:\.js)?['"\x60]`
const REACHES = (spec) => new RegExp(String.raw`\bfrom\s*${spec}|\b(?:import|require)\s*\(\s*${spec}`)
/** Does this phone file's code reach a server-only reader of shared/dashboard-data or shared/studio-kpis? */
export function importsServerOnlyReader(code) {
  if (REACHES(STUDIO_KPIS).test(code)) return true
  return REACHES(DASHBOARD_DATA).test(code) && /\bfetch(StudioContactCounts|FunnelCounts|AdsSummary)\b/.test(code)
}
