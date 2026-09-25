#!/usr/bin/env node
// RLS restrictive-policy lint (RLS-RESTRICTIVE.1).
//
// Fails CI when a table's permissive SELECT policy is folded away by a
// restrictive policy that also covers SELECT. Postgres evaluates RLS as
// (OR of permissive) AND (AND of restrictive), and `FOR ALL` includes
// SELECT — so the extremely natural-looking
//
//     CREATE POLICY <x>_deny_writes ON public.<t>
//       AS RESTRICTIVE FOR ALL TO authenticated, anon
//       USING (false) WITH CHECK (false);
//
// does not deny *writes*. It denies everything, including the read the
// permissive SELECT policy two lines above was written to allow.
//
// Nothing catches this at runtime. The read returns an EMPTY SET, not an
// error, and Supabase realtime — which authorises every postgres_changes
// row through the subscriber's SELECT policy — simply never delivers.
// That is how the pattern reached 16 tables across ~300 migrations,
// killing the realtime listeners in EmailInbox, IGInbox and UnifiedInbox
// under a 60-second poll that hid the failure. Migs 483 and 485 fixed
// them; this script is what stops #17.
//
// Model: replay every migration in filename order, tracking CREATE /
// DROP / ALTER POLICY (TO / USING / WITH CHECK / RENAME TO), DROP TABLE
// and ALTER TABLE … RENAME TO (a policy moves with its table) to get the
// NET policy state — a grep for CREATE POLICY is wrong, since several of
// these were dropped, recreated, altered or renamed along the way. Then flag any table where BOTH hold:
//
//   - a RESTRICTIVE policy with `USING (false)` whose command is ALL or
//     SELECT and whose roles reach `authenticated` (directly or via
//     `public`), AND
//   - a PERMISSIVE SELECT policy whose roles also reach `authenticated`.
//
// Deliberately NOT flagged:
//   - restrictive policies scoped `TO anon` only. Denying anon while
//     authenticated reads is the correct shape (mig 169, and mig 485's
//     `_deny_anon` backstops). anon losing a `TO public` SELECT policy
//     to such a backstop is intended, not a defect.
//   - tables with no permissive SELECT policy at all (ac_sessions,
//     cron_heartbeats, device_tokens, …). There is no read to break;
//     the restrictive is a backstop over default-deny.
//   - CONDITIONAL restrictives — `USING (bucket_id NOT IN (...))` on
//     storage.objects (mig 403) deliberately denies SELECT on private
//     buckets. Only `USING (false)` is unambiguously the bug.
//
// This is a tripwire, not a prover: it reasons about policy DDL in the
// migration files, which is authoritative only because migrations are
// forward-only and applied exclusively via Supabase MCP. A policy
// created by hand in the dashboard is invisible to it.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MIG_DIR = 'supabase/migrations'

// table → reason. A table listed here asserts you have READ the policies
// and confirmed the suppressed SELECT is intentional. Don't add blind.
const EXEMPT = {}

const IDENT = String.raw`(?:"[^"]+"|[\w]+)`
const TABLE = String.raw`(?:(?:"[^"]+"|[\w]+)\s*\.\s*)?(?:"[^"]+"|[\w]+)`

const RE_CREATE = new RegExp(
  String.raw`\bCREATE\s+POLICY\s+(${IDENT})\s+ON\s+(?:TABLE\s+)?(${TABLE})([\s\S]*)`, 'i')
const RE_DROP = new RegExp(
  String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${TABLE})`, 'i')
const RE_DROP_TABLE = new RegExp(
  String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${TABLE})`, 'i')
const RE_RENAME_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${TABLE})\s+RENAME\s+TO\s+(${IDENT})\s*$`, 'i')
const RE_ALTER_POLICY = new RegExp(
  String.raw`\bALTER\s+POLICY\s+(${IDENT})\s+ON\s+(${TABLE})([\s\S]*)`, 'i')

function stripSql (text) {
  // Dollar-quoted bodies can contain semicolons and their own DDL; the
  // conditional `DO $$ ... $$` wrappers in this repo only ever drop
  // policies defensively, so dropping the body wholesale is safe here.
  return text
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function normIdent (s) {
  const t = s.trim()
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t.toLowerCase()
}

function normTable (s) {
  const parts = (s.match(/"[^"]+"|[\w]+/g) || []).map(normIdent)
  return parts.length === 1 ? `public.${parts[0]}` : parts.slice(-2).join('.')
}

// The parenthesised argument of a top-level `USING (…)` / `WITH CHECK (…)`
// in a policy tail. Top level = paren depth 0 outside quotes, so a
// `JOIN … USING (id)` inside the expression is never mistaken for it.
function topLevelClause (tail, keyword) {
  const kw = new RegExp(String.raw`^${keyword}\s*\(`, 'i')
  let depth = 0
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]
    if (ch === "'") { i = tail.indexOf("'", i + 1); if (i < 0) return null; continue }
    if (ch === '"') { i = tail.indexOf('"', i + 1); if (i < 0) return null; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (depth !== 0 || (i > 0 && /\w/.test(tail[i - 1]))) continue
    const m = tail.slice(i).match(kw)
    if (!m) continue
    const start = i + m[0].length
    let d = 1
    for (let j = start; j < tail.length; j++) {
      const c = tail[j]
      if (c === "'") { j = tail.indexOf("'", j + 1); if (j < 0) return null; continue }
      if (c === '"') { j = tail.indexOf('"', j + 1); if (j < 0) return null; continue }
      if (c === '(') d++
      else if (c === ')' && --d === 0) return tail.slice(start, j).trim()
    }
    return null
  }
  return null
}

function parseRoles (tail) {
  const toMatch = tail.match(/(?:^|\s)TO\s+([\w",\s]+?)(?=\bUSING\b|\bWITH\b|$)/i)
  return toMatch ? toMatch[1].split(',').map(normIdent).filter(Boolean) : null
}

function parseTail (body) {
  const permissive = /\bAS\s+RESTRICTIVE\b/i.test(body) ? 'RESTRICTIVE' : 'PERMISSIVE'
  const cmdMatch = body.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)
  // `FOR ALL` is the Postgres default when FOR is omitted.
  const cmd = cmdMatch ? cmdMatch[1].toUpperCase() : 'ALL'
  // Omitting TO defaults to PUBLIC (every role).
  const roles = parseRoles(body) || ['public']
  const using = topLevelClause(body, 'USING')
  const check = topLevelClause(body, String.raw`WITH\s+CHECK`)
  return { permissive, cmd, roles, using, check, usingFalse: /^\s*false\s*$/i.test(using || '') }
}

// The tail a policy would be re-created from after ALTER POLICY rewrote it.
function rebuildBody (p) {
  return `AS ${p.permissive} FOR ${p.cmd} TO ${p.roles.join(', ')}` +
    (p.using != null ? ` USING (${p.using})` : '') +
    (p.check != null ? ` WITH CHECK (${p.check})` : '')
}

// `public` is every role, so it reaches authenticated.
const reachesAuthenticated = (roles) =>
  roles.includes('authenticated') || roles.includes('public')

const coversSelect = (cmd) => cmd === 'ALL' || cmd === 'SELECT'

// Exported for tests/rls-active-staff-gate.test.js (RLSACTIVE.1), which
// reads each policy's `body` (everything after `ON <table>`) to prove every
// inline read of a profile table carries the active-staff gate. `before`
// replays only migrations numbered below it (the state a migration lands on).
export function netPolicyState (migDir = MIG_DIR, { before = Infinity } = {}) {
  const files = fs.readdirSync(migDir)
    .filter((f) => f.endsWith('.sql') && (before === Infinity || parseInt(f, 10) < before))
    .sort((a, b) => {
      const na = parseInt(a, 10)
      const nb = parseInt(b, 10)
      if (na !== nb) return na - nb
      return a.localeCompare(b)
    })

  // table -> (policy name -> policy). Nested rather than a composite
  // string key: quoted policy names legitimately contain spaces in this
  // repo (e.g. "champ_push_tokens deny anon", mig 295), so any single
  // separator character risks a collision.
  const policies = new Map()

  for (const file of files) {
    const sql = stripSql(fs.readFileSync(path.join(migDir, file), 'utf8'))
    for (const raw of sql.split(';')) {
      const stmt = raw.trim()
      if (!stmt) continue

      if (/\bDROP\s+TABLE\b/i.test(stmt) && !/\bCREATE\b/i.test(stmt)) {
        const m = stmt.match(RE_DROP_TABLE)
        if (m) policies.delete(normTable(m[1]))
        continue
      }

      if (/\bCREATE\s+POLICY\b/i.test(stmt)) {
        const m = stmt.match(RE_CREATE)
        if (m) {
          const table = normTable(m[2])
          const name = normIdent(m[1])
          if (!policies.has(table)) policies.set(table, new Map())
          policies.get(table).set(name, {
            table, name, file, body: m[3].trim(), ...parseTail(m[3]),
          })
        }
        continue
      }

      if (/\bDROP\s+POLICY\b/i.test(stmt)) {
        const m = stmt.match(RE_DROP)
        if (m) policies.get(normTable(m[2]))?.delete(normIdent(m[1]))
        continue
      }

      // A policy moves with its table (mig 185: inbound_invoices → invoices_queue).
      if (/\bALTER\s+TABLE\b/i.test(stmt) && /\bRENAME\s+TO\b/i.test(stmt)) {
        const m = stmt.match(RE_RENAME_TABLE)
        if (m) {
          const from = normTable(m[1])
          const to = `${from.split('.')[0]}.${normIdent(m[2])}`
          const byName = policies.get(from)
          if (byName) {
            policies.delete(from)
            for (const p of byName.values()) p.table = to
            policies.set(to, byName)
          }
        }
        continue
      }

      // ALTER POLICY replaces only the clauses it names (mig 204's USING
      // rewrites; mig 050's TO authenticated); RENAME TO re-keys it.
      if (/\bALTER\s+POLICY\b/i.test(stmt)) {
        const m = stmt.match(RE_ALTER_POLICY)
        if (!m) continue
        const byName = policies.get(normTable(m[2]))
        const p = byName?.get(normIdent(m[1]))
        if (!p) continue
        const tail = m[3]
        const rename = tail.match(new RegExp(String.raw`^\s*RENAME\s+TO\s+(${IDENT})\s*$`, 'i'))
        if (rename) {
          byName.delete(p.name)
          p.name = normIdent(rename[1])
          byName.set(p.name, p)
          continue
        }
        const roles = parseRoles(tail)
        const using = topLevelClause(tail, 'USING')
        const check = topLevelClause(tail, String.raw`WITH\s+CHECK`)
        if (roles) p.roles = roles
        if (using != null) p.using = using
        if (check != null) p.check = check
        p.usingFalse = /^\s*false\s*$/i.test(p.using || '')
        p.body = rebuildBody(p)
        p.file = file
      }
    }
  }
  return [...policies.values()].flatMap((byName) => [...byName.values()])
}

function main () {
  if (!fs.existsSync(MIG_DIR)) {
    console.error(`check:rls-restrictive — ${MIG_DIR} not found`)
    process.exit(1)
  }

  const byTable = new Map()
  for (const p of netPolicyState()) {
    if (!byTable.has(p.table)) byTable.set(p.table, [])
    byTable.get(p.table).push(p)
  }

  const violations = []
  for (const [table, ps] of [...byTable].sort()) {
    const killers = ps.filter((p) =>
      p.permissive === 'RESTRICTIVE' &&
      p.usingFalse &&
      coversSelect(p.cmd) &&
      reachesAuthenticated(p.roles))
    if (!killers.length) continue

    const reads = ps.filter((p) =>
      p.permissive === 'PERMISSIVE' &&
      coversSelect(p.cmd) &&
      reachesAuthenticated(p.roles))
    if (!reads.length) continue

    if (EXEMPT[table]) continue
    violations.push({ table, killers, reads })
  }

  if (!violations.length) {
    console.log(
      `check:rls-restrictive — OK (${byTable.size} tables, no permissive ` +
      'SELECT policy suppressed by a restrictive USING(false))')
    return
  }

  console.error(
    `\ncheck:rls-restrictive — ${violations.length} table(s) where a ` +
    'restrictive policy silently denies the permissive SELECT:\n')
  for (const v of violations) {
    console.error(`  ${v.table}`)
    for (const k of v.killers) {
      console.error(
        `    DENIES   ${k.name}  AS RESTRICTIVE FOR ${k.cmd} ` +
        `TO ${k.roles.join(', ')} USING (false)   [${k.file}]`)
    }
    for (const r of v.reads) {
      console.error(
        `    BLOCKED  ${r.name}  FOR ${r.cmd} TO ${r.roles.join(', ')}` +
        `   [${r.file}]`)
    }
    console.error('')
  }
  console.error(
    'Fix: split the restrictive FOR ALL into per-command INSERT / UPDATE /\n' +
    'DELETE restrictives so SELECT survives, keeping a FOR ALL restrictive\n' +
    'scoped TO anon if anon must stay fully denied. See migration 485.\n')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
