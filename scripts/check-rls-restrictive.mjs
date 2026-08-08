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
// DROP / ALTER POLICY (and DROP TABLE) to get the NET policy state — a
// grep for CREATE POLICY is wrong, since several of these were dropped
// and recreated along the way. Then flag any table where BOTH hold:
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

function parseTail (body) {
  const permissive = /\bAS\s+RESTRICTIVE\b/i.test(body) ? 'RESTRICTIVE' : 'PERMISSIVE'
  const cmdMatch = body.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)
  // `FOR ALL` is the Postgres default when FOR is omitted.
  const cmd = cmdMatch ? cmdMatch[1].toUpperCase() : 'ALL'
  const toMatch = body.match(/\bTO\s+([\w",\s]+?)(?=\bUSING\b|\bWITH\b|$)/i)
  // Omitting TO defaults to PUBLIC (every role).
  const roles = toMatch
    ? toMatch[1].split(',').map(normIdent).filter(Boolean)
    : ['public']
  return {
    permissive,
    cmd,
    roles,
    usingFalse: /\bUSING\s*\(\s*false\s*\)/i.test(body),
  }
}

// `public` is every role, so it reaches authenticated.
const reachesAuthenticated = (roles) =>
  roles.includes('authenticated') || roles.includes('public')

const coversSelect = (cmd) => cmd === 'ALL' || cmd === 'SELECT'

function netPolicyState () {
  const files = fs.readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
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
    const sql = stripSql(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'))
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
            table, name, file, ...parseTail(m[3]),
          })
        }
        continue
      }

      if (/\bDROP\s+POLICY\b/i.test(stmt)) {
        const m = stmt.match(RE_DROP)
        if (m) policies.get(normTable(m[2]))?.delete(normIdent(m[1]))
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

main()
