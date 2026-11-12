// MCP.1 guard: the agent tool registry (src/lib/agent-tools/). Every tool runs
// on the service-role client, so RLS fences nothing. This guard is a floor, not
// proof: it reads each tool's source for the rules below. An id-set filter
// (`.in('id', ids)`, `.in('contact_id', ids)`) proves only what the caller
// established before building the set (contactsAtStudio, a readability check),
// so each tool's own test is the second net. A single-row read by id needs a
// `location_id` filter in the same chain or an id-set; `.eq('id', x)` alone is
// not a studio filter.
//
//  1. Every tool module is `export default defineTool({ … })` with an optional
//     `studio_id: uuidLike.optional()` in its inputSchema and a gate.
//     uuidLike, NOT z.string().uuid(): zod 4's .uuid() is RFC-strict and
//     REJECTS UN1T Stillorgan's seeded location id
//     (a0000000-0000-0000-0000-000000000001, version nibble 0), so every
//     tool call naming that studio answered invalid_input. ASSISTREG.3.
//  2. index.js lists every tool module exactly once (and nothing else).
//  3. No tool names a table that is out of scope for v1 (messaging, cars,
//     Xero, fees, trial purchases, un1t.online writes), as `.from('<t>')` or
//     as an embed inside a select string.
//  4. Every `.from(…)` chain carries a studio or contact-set filter:
//     .eq/.in('location_id', …), .eq/.in('contact_id', …), .in('id', …).
//     An `.insert(…)` chain is exempt: its fence is the `location_id` /
//     `contact_id` the tool stamps in the row, which each write tool's own
//     test pins.
//  5. No tool selects `*` (or a bare `.select()`, which is `*`) from
//     profiles, locations or contacts, directly or as an embed: each has a
//     REVOKE in its history, and a service-role `*` ships what it hides.
//  6. MCPEMAIL.1 — no tool can send an email campaign. (a) No file names
//     `releaseCampaign` or `consumeApproval`: a release happens only on the
//     signed-in approve route. (b) No `.from('campaigns')` insert/update/upsert
//     writes a `status` other than the literal 'draft', read from the object
//     literal passed in or, for a named patch (`.update(patch)`), from its
//     `const patch = {…}`, every `Object.assign(patch, …)` and any
//     `patch.status = …`. The one documented exception is the cancel tool,
//     which stops a campaign through `stopCampaign` (a lib outside this scan),
//     so cancel-email-campaign.js must be the only file naming it. (c) Every
//     APPROVAL_CONTENT_FIELDS column is in CAMPAIGN_COLS and in the approve
//     view's APPROVAL_CAMPAIGN_COLUMNS, so a short select can never weaken the
//     binding (campaignContentKey would throw, but only at run time).
//
// A floor, not a proof: a chain built across statements (`let q = …; q =
// q.eq(…)`) reads as unfiltered (a false positive, by design: build the query
// in one expression), and a table or select string held in a variable is
// invisible to rules 3 and 5. Rule 6b cannot see a `status` that arrives
// through a spread (`...body`) or a helper that builds the patch elsewhere.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = path.join(ROOT, 'src/lib/agent-tools')
const NOT_TOOLS = new Set(['registry.js', 'index.js', '_dates.js', '_staff-report.js', '_contact-scope.js', '_email-campaign.js', '_email-draft.js'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

const FORBIDDEN_TABLE = /^(whatsapp_\w+|email_\w+|instagram_\w+|cars\w*|car_\w+|xero_\w+|class_fees\w*|trial_purchases|un1t_write_\w+)$/
const NO_STAR_TABLES = new Set(['profiles', 'locations', 'contacts'])
const INSERT_CHAIN = /\.\s*insert\(/
const SCOPE_FILTER = /\.\s*(?:(?:eq|in)\(\s*(['"`])(?:location_id|contact_id)\1|in\(\s*(['"`])id\2)/

function sourceFiles() {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((n) => /\.js$/.test(n) && !/\.test\.js$/.test(n))
    .map((n) => path.join(DIR, n))
}
const toolFiles = () => sourceFiles().filter((f) => !NOT_TOOLS.has(path.basename(f)))
const codeOf = (file) => stripComments(readFileSync(file, 'utf8'), file)

// ── scanners (exported for the self-tests below) ────────────────────────────

const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const unquote = (s) => s.slice(1, -1)

/** Index just past the bracket group that opens at `i` (string-aware). */
function skipGroup(code, i) {
  const open = code[i]
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let k = i; k < code.length; k++) {
    const ch = code[k]
    if (ch === '\'' || ch === '"' || ch === '`') {
      STRING.lastIndex = k
      const m = STRING.exec(code)
      if (m && m.index === k) { k += m[0].length - 1; continue }
    }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return k + 1
  }
  return code.length
}

/** The whole member/call chain that starts at the `.` at `start`. */
export function chainAt(code, start) {
  let i = start
  for (;;) {
    if (code.startsWith('?.', i)) i += 2
    else if (code[i] === '.') i += 1
    else break
    const id = /^\s*[A-Za-z_$][\w$]*/.exec(code.slice(i))
    if (!id) break
    i += id[0].length
    for (;;) {
      const ws = /^\s*/.exec(code.slice(i))[0].length
      if (code[i + ws] === '(' || code[i + ws] === '[') i = skipGroup(code, i + ws)
      else break
    }
    const ws = /^\s*/.exec(code.slice(i))[0].length
    if (code[i + ws] === '.' || code.startsWith('?.', i + ws)) i += ws
    else break
  }
  return code.slice(start, i)
}

/** Every supabase `.from(…)` chain: `{ table, chain }`, table null when not a literal. */
export function fromChains(code) {
  const out = []
  // Built-in `.from` (Array.from, Buffer.from, …) is not a supabase client.
  for (const m of code.matchAll(/(?<!\b(?:Array|Buffer|Set|Map|Object|Uint8Array|Int8Array|Float64Array|BigInt64Array)\s*)\.from\(/g)) {
    const chain = chainAt(code, m.index)
    const lit = /^\.from\(\s*(['"`])([\w.]+)\1\s*\)/.exec(chain)
    out.push({ table: lit ? lit[2] : null, chain })
  }
  return out
}

const embedsIn = (str) => [...str.matchAll(/(?:^|[\s,(])(?:\w+\s*:\s*)?([a-z_][\w]*)\s*(?::\s*\w+\s*)?(?:!\s*\w+\s*)?\(/g)].map((m) => m[1])

/** Out-of-scope tables a source names, as `.from()` or as an embed. */
export function forbiddenTables(code) {
  const hits = fromChains(code).map((c) => c.table).filter((t) => t && FORBIDDEN_TABLE.test(t))
  for (const s of code.match(STRING) || []) {
    for (const name of embedsIn(unquote(s))) if (FORBIDDEN_TABLE.test(name)) hits.push(name)
  }
  return hits
}

/** `.from()` chains with no studio or contact-set filter. */
export function unscopedChains(code) {
  return fromChains(code)
    .filter((c) => !SCOPE_FILTER.test(c.chain) && !INSERT_CHAIN.test(c.chain))
    .map((c) => c.chain.split('\n')[0].trim())
}

function topLevelColumns(sel) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/** `*` (or a bare select) read from profiles, locations or contacts. */
export function starSelects(code) {
  const hits = []
  for (const { table, chain } of fromChains(code)) {
    if (!NO_STAR_TABLES.has(table)) continue
    for (const m of chain.matchAll(/\.\s*select\(\s*(\)|(['"`])((?:(?!\2)[^\\]|\\.)*)\2)/g)) {
      if (m[1] === ')') hits.push(`${table}: .select()`)
      else if (topLevelColumns(m[3]).includes('*')) hits.push(`${table}: .select('${m[3]}')`)
    }
  }
  for (const s of code.match(STRING) || []) {
    for (const m of unquote(s).matchAll(/(?:^|[\s,(:])(profiles|locations|contacts)\s*(?::\s*\w+\s*)?(?:!\s*\w+\s*)?\(\s*\*/g)) {
      hits.push(`${m[1]}(*) embed`)
    }
  }
  return hits
}

/** Files' names for the release-side functions no tool may reach. */
export function releaseReferences(code) {
  return [...code.matchAll(/\b(releaseCampaign|consumeApproval)\b/g)].map((m) => m[1])
}

const groupText = (code, open) => code.slice(open + 1, skipGroup(code, open) - 1)

/** `status` keys in an object's text whose value is not the literal 'draft'. */
function badStatusKeys(text) {
  const bad = []
  for (const m of text.matchAll(/(?<![\w$.'"`])status\s*:\s*/g)) {
    const rest = text.slice(m.index + m[0].length)
    if (!/^(['"`])draft\1(?=\s*(?:[,}\n]|$))/.test(rest)) bad.push(`status: ${rest.split(/[,}\n]/)[0].trim()}`)
  }
  for (const m of text.matchAll(/(?:^|[{,])\s*status\s*(?=[,}]|$)/g)) bad.push(`{ ${m[0].replace(/[{,]/, '').trim()} } (shorthand)`)
  return bad
}

/** The status writes made through a named patch object `name`. */
function badStatusInPatch(code, name) {
  const bad = []
  const n = name.replace(/\$/g, '\\$')
  let declared = false
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=\\s*`, 'g'))) {
    declared = true
    const at = m.index + m[0].length
    if (code[at] === '{') bad.push(...badStatusKeys(groupText(code, at)))
    else bad.push(`${name} = ${code.slice(at).split('\n')[0].trim()} (not an object literal)`)
  }
  for (const m of code.matchAll(new RegExp(`\\bObject\\s*\\.\\s*assign\\(\\s*${n}\\s*,`, 'g'))) {
    bad.push(...badStatusKeys(groupText(code, m.index + m[0].indexOf('('))))
  }
  for (const m of code.matchAll(new RegExp(`\\b${n}\\s*(?:\\.\\s*status|\\[\\s*(['"\`])status\\1\\s*\\])\\s*=(?!=)\\s*`, 'g'))) {
    const rest = code.slice(m.index + m[0].length)
    if (!/^(['"`])draft\1/.test(rest)) bad.push(`${name}.status = ${rest.split('\n')[0].trim()}`)
  }
  if (!declared) bad.push(`${name}: no object literal declared in this file`)
  return bad
}

/** Writes to `campaigns` that set a status other than 'draft'. */
export function campaignStatusWrites(code) {
  const bad = []
  for (const { table, chain } of fromChains(code)) {
    if (table !== 'campaigns') continue
    for (const m of chain.matchAll(/\.\s*(insert|update|upsert)\s*\(/g)) {
      const arg = groupText(chain, m.index + m[0].length - 1).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) bad.push(...badStatusInPatch(code, arg))
      else if (/^[[{]/.test(arg)) bad.push(...badStatusKeys(arg))
      else bad.push(`.${m[1]}(${arg.split('\n')[0]}): not an object literal or a named patch`)
    }
  }
  return bad
}

/** Column names in a comma-separated select string (top level only). */
const columnNames = (sel) => topLevelColumns(sel).filter(Boolean)

// ── the rules, over the real registry ───────────────────────────────────────

describe('agent tools guard (MCP.1)', () => {
  const tools = toolFiles()

  it('scans the files it is meant to police (not vacuous)', () => {
    expect(tools.map(rel)).toEqual(expect.arrayContaining(['src/lib/agent-tools/whoami.js']))
  })

  it('every tool module calls defineTool with a studio_id in its inputSchema and a gate', () => {
    const bad = tools.filter((f) => {
      const code = codeOf(f)
      return !/export\s+default\s+defineTool\(\s*\{/.test(code) ||
        !/\bstudio_id\s*:\s*uuidLike\s*\.\s*optional\(\s*\)/.test(code) ||
        !/\bgate\s*[:(]/.test(code)
    }).map(rel)
    expect(bad, `each tool must be \`export default defineTool({ … })\` with studio_id: uuidLike.optional() and a gate (uuidLike, never z.string().uuid(), which rejects Stillorgan's seeded id):\n${bad.join('\n')}`).toEqual([])
  })

  it('every tool is listed in index.js exactly once', async () => {
    const index = codeOf(path.join(DIR, 'index.js'))
    const miscounted = tools.map((f) => {
      const base = path.basename(f, '.js')
      const n = [...index.matchAll(new RegExp(`from\\s+['"]\\./${base}(?:\\.js)?['"]`, 'g'))].length
      return n === 1 ? null : `${rel(f)} imported ${n} times`
    }).filter(Boolean)
    expect(miscounted, miscounted.join('\n')).toEqual([])

    const { TOOLS } = await import('@/lib/agent-tools/index.js')
    const modules = await Promise.all(tools.map((f) => import(f)))
    expect(TOOLS).toHaveLength(tools.length)
    for (const [k, mod] of modules.entries()) {
      expect(TOOLS.filter((t) => t === mod.default), `${rel(tools[k])} must be in TOOLS exactly once`).toHaveLength(1)
      expect(mod.default.inputSchema.shape.studio_id, rel(tools[k])).toBeDefined()
    }
    const names = TOOLS.map((t) => t.name)
    expect(new Set(names).size, `duplicate tool names: ${names.join(', ')}`).toBe(names.length)
  })

  // MCPACCESS.1 — a tool's `title` and `description` are shipped to the MCP
  // client in the tool list, so they are what Claude repeats to the operator.
  // The MCP gate is `mcp_access` ("Connect an Agent"); naming the AI Assistant
  // permission here tells a refused person to switch on the paid, uncapped
  // in-app chat that is deliberately off — the confusion this whole change
  // exists to remove. Comments are not shipped and are not checked.
  it('no tool description or title names the AI Assistant permission', async () => {
    const { TOOLS } = await import('@/lib/agent-tools/index.js')
    const offenders = TOOLS
      .filter((t) => /ai assistant/i.test(`${t.title} ${t.description}`))
      .map((t) => t.name)
    expect(offenders, `agent-facing text names the wrong permission: ${offenders.join(', ')}`).toEqual([])
  })

  it('no tool names a forbidden table', () => {
    const bad = sourceFiles().flatMap((f) => forbiddenTables(codeOf(f)).map((t) => `${rel(f)}: ${t}`))
    expect(bad, `out-of-scope tables for MCP v1:\n${bad.join('\n')}`).toEqual([])
  })

  it('every .from() in a tool is followed by a studio or contact-set filter within the same chain', () => {
    const bad = sourceFiles().flatMap((f) => unscopedChains(codeOf(f)).map((c) => `${rel(f)}: ${c}`))
    expect(bad, `add .eq/.in('location_id' | 'contact_id', …) or .in('id', ids) to the same chain:\n${bad.join('\n')}`).toEqual([])
  })

  it('no tool selects * from profiles, locations or contacts', () => {
    const bad = sourceFiles().flatMap((f) => starSelects(codeOf(f)).map((s) => `${rel(f)}: ${s}`))
    expect(bad, `name the columns:\n${bad.join('\n')}`).toEqual([])
  })

  // MCPEMAIL.1 — the central promise: no tool can send a campaign.
  it('no tool file reaches releaseCampaign or consumeApproval', () => {
    const bad = sourceFiles().flatMap((f) => releaseReferences(codeOf(f)).map((n) => `${rel(f)}: ${n}`))
    expect(bad, `a release happens only on the signed-in approve route:\n${bad.join('\n')}`).toEqual([])
  })

  it("no tool writes a campaign status other than 'draft'", () => {
    const campaignWriters = sourceFiles().filter((f) => fromChains(codeOf(f)).some((c) => c.table === 'campaigns' && /\.\s*(?:insert|update|upsert)\s*\(/.test(c.chain)))
    // Not vacuous: the create and update tools write campaigns directly.
    expect(campaignWriters.map(rel)).toEqual(expect.arrayContaining([
      'src/lib/agent-tools/create-email-draft.js', 'src/lib/agent-tools/update-email-draft.js',
    ]))
    const bad = sourceFiles().flatMap((f) => campaignStatusWrites(codeOf(f)).map((s) => `${rel(f)}: ${s}`))
    expect(bad, `a tool may only ever leave a campaign in draft:\n${bad.join('\n')}`).toEqual([])
  })

  it('only the cancel tool reaches stopCampaign (the documented exception)', () => {
    const users = sourceFiles().filter((f) => /\bstopCampaign\b/.test(codeOf(f))).map(rel)
    expect(users).toEqual(['src/lib/agent-tools/cancel-email-campaign.js'])
  })

  it('every approval content field is read by the tools and by the approve view', async () => {
    const { APPROVAL_CONTENT_FIELDS } = await import('@/lib/campaign-approval')
    const { CAMPAIGN_COLS } = await import('@/lib/agent-tools/_email-campaign.js')
    const { APPROVAL_CAMPAIGN_COLUMNS } = await import('@/lib/campaign-approval-view')
    expect(APPROVAL_CONTENT_FIELDS.length).toBeGreaterThanOrEqual(13)
    for (const [name, cols] of [['CAMPAIGN_COLS', CAMPAIGN_COLS], ['APPROVAL_CAMPAIGN_COLUMNS', APPROVAL_CAMPAIGN_COLUMNS]]) {
      const have = new Set(columnNames(cols))
      const missing = APPROVAL_CONTENT_FIELDS.filter((f) => !have.has(f))
      expect(missing, `${name} must read every approval content field`).toEqual([])
    }
  })
})

// ── the scanners catch what they claim to (only whoami exists today) ────────

describe('agent tools guard scanners', () => {
  it('reads a whole multi-line chain and ignores Array.from', () => {
    const code = `const xs = Array.from(set)\nconst { data } = await db\n  .from('deals')\n  .select('id, title')\n  .eq('location_id', studio.id)\n  .limit(50)\nfoo()`
    const chains = fromChains(code)
    expect(chains).toHaveLength(1)
    expect(chains[0].table).toBe('deals')
    expect(chains[0].chain).toMatch(/\.limit\(50\)$/)
    expect(unscopedChains(code)).toEqual([])
  })

  it('flags a chain with no studio or contact-set filter', () => {
    expect(unscopedChains(`await db.from('deals').select('id').eq('status', 'open')`)).toHaveLength(1)
    expect(unscopedChains(`await db.from('contacts').select('id').in('id', ids)`)).toEqual([])
    expect(unscopedChains(`await db.from('notes').select('id').eq('contact_id', c)`)).toEqual([])
    expect(unscopedChains(`await db.from('bookings').select('id').in("location_id", ids)`)).toEqual([])
  })

  it('exempts an insert chain (its fence is the stamped row) and nothing else', () => {
    expect(unscopedChains(`await db.from('contacts').insert({ name, location_id: studio.id }).select('id, name').single()`)).toEqual([])
    expect(unscopedChains(`await db\n  .from('activities')\n  .insert(record)\n  .select('id')\n  .single()`)).toEqual([])
    expect(unscopedChains(`await db.from('activities').update({ done: true }).eq('id', x)`)).toHaveLength(1)
    expect(unscopedChains(`await db.from('activities').upsert(row).select('id')`)).toHaveLength(1)
    expect(unscopedChains(`await db.from('activities').delete().eq('id', x)`)).toHaveLength(1)
  })

  it('does not take .eq(\'id\') alone as a studio filter', () => {
    expect(unscopedChains(`db.from('deals').select('id').eq('id', x)`)).toHaveLength(1)
    expect(unscopedChains(`db.from('deals').select('id').eq('id', x).eq('location_id', s)`)).toEqual([])
    expect(unscopedChains(`db.from('contacts').select('id').in('id', ids)`)).toEqual([])
  })

  it('reads any client receiver, capitalised or not, and skips only built-ins', () => {
    expect(forbiddenTables(`serviceDb.from('cars').select('id').eq('location_id', s)`)).toEqual(['cars'])
    expect(starSelects(`supabaseAdmin.from('contacts').select().eq('id', x)`)).toHaveLength(1)
    expect(unscopedChains(`supabaseAdmin.from('deals').select('id')`)).toHaveLength(1)
    expect(fromChains(`Array.from(x); Buffer.from(y); Uint8Array.from(z)`)).toEqual([])
  })

  it('flags forbidden tables as .from() and as embeds, not as columns', () => {
    expect(forbiddenTables(`db.from('whatsapp_messages').select('id').eq('id', x)`)).toEqual(['whatsapp_messages'])
    expect(forbiddenTables(`db.from('cars').select('id').eq('id', x)`)).toEqual(['cars'])
    expect(forbiddenTables(`db.from('contacts').select('id, email_sends(id)').eq('id', x)`)).toEqual(['email_sends'])
    expect(forbiddenTables(`db.from('deals').select('id, car:car_documents!car_id(path)').eq('id', x)`)).toEqual(['car_documents'])
    expect(forbiddenTables(`db.from('contacts').select('id, email_marketing, car_id').eq('id', x)`)).toEqual([])
  })

  it('flags * and bare selects on the three tables, directly and embedded', () => {
    expect(starSelects(`db.from('contacts').select('*').eq('id', x)`)).toHaveLength(1)
    expect(starSelects(`db.from('profiles').select().eq('id', x)`)).toHaveLength(1)
    expect(starSelects(`db.from('locations').select('id, *').eq('id', x)`)).toHaveLength(1)
    expect(starSelects(`db.from('deals').select('id, contacts!contact_id(*)').eq('id', x)`)).toHaveLength(1)
    expect(starSelects(`db.from('deals').select('*, contacts!contact_id(id, first_name)').eq('location_id', s)`)).toEqual([])
    expect(starSelects(`db.from('contacts').select('id, deals(*)').eq('id', x)`)).toEqual([])
  })

  it('flags a release-side name, and only those two', () => {
    expect(releaseReferences(`import { releaseCampaign } from '@/lib/campaign-release'`)).toEqual(['releaseCampaign'])
    expect(releaseReferences(`await consumeApproval(db, id)`)).toEqual(['consumeApproval'])
    expect(releaseReferences(`import { releasePreflight, stopCampaign } from '@/lib/campaign-release'`)).toEqual([])
  })

  it('reads a campaign status from an inline object, a named patch, Object.assign and an assignment', () => {
    expect(campaignStatusWrites(`await db.from('campaigns').update({ status: 'queued' }).eq('id', x).eq('location_id', s)`)).toHaveLength(1)
    expect(campaignStatusWrites(`await db.from('campaigns').insert([{ name, status: "scheduled" }]).select('id')`)).toHaveLength(1)
    expect(campaignStatusWrites(`await db.from('campaigns').update({ status }).eq('id', x)`)).toHaveLength(1)
    expect(campaignStatusWrites(`await db.from('campaigns').update({ status: 'draft', scheduled_at: null }).eq('id', x)`)).toEqual([])
    expect(campaignStatusWrites(`const row = { status: 'draft', name }\nawait db.from('campaigns').insert(row).select('id')`)).toEqual([])
    expect(campaignStatusWrites(`const row = { status: next }\nawait db.from('campaigns').insert(row).select('id')`)).toHaveLength(1)
    expect(campaignStatusWrites(`const patch = {}\nObject.assign(patch, { status: 'draft' })\nawait db.from('campaigns').update(patch).eq('id', x)`)).toEqual([])
    expect(campaignStatusWrites(`const patch = {}\nObject.assign(patch, { status: 'queued' })\nawait db.from('campaigns').update(patch).eq('id', x)`)).toHaveLength(1)
    expect(campaignStatusWrites(`const patch = {}\npatch.status = 'sending'\nawait db.from('campaigns').update(patch).eq('id', x)`)).toHaveLength(1)
    expect(campaignStatusWrites(`await db.from('campaigns').update(makePatch()).eq('id', x)`)).toHaveLength(1)
    expect(campaignStatusWrites(`await db.from('campaigns').update(patch).eq('id', x)`)).toHaveLength(1)
    // Another table's status and a returned object are not campaign writes.
    expect(campaignStatusWrites(`await db.from('activities').insert({ status: 'todo' }).select('id')`)).toEqual([])
    expect(campaignStatusWrites(`return { status: result.status }`)).toEqual([])
  })
})
