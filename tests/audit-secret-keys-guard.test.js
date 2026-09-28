// AUDITSECRETS.1 (mig 647) guard: the audit trigger redacts credentials by
// KEY NAME (private.audit_is_secret_key). A credential stored under a name the
// rule does not match would reach audit_events in clear, so this fails when:
//   1. an integration route declares a secret field (`secretFields: [...]`)
//      whose name the rule does not match;
//   2. a migration after 647 adds a secret-looking column to an audited table
//      and the rule does not match it (or it is not a known look-alike);
//   3. a migration after 647 attaches private.log_mutation (under any trigger
//      name) to a new table without adding that table to AUDITED_TABLES (so
//      check 2 covers it).
// Like check:select-columns it is a floor, not a proof: a secret under a
// name like `dsn` or `url` is invisible to it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  AUDITED_TABLES,
  KNOWN_NOT_SECRET_NAMES,
  isAuditSecretKey,
} from './helpers/audit-secret-keys.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const REDACT_MIGRATION = 647

// A name that LOOKS like it could hold a credential. Broader than the rule on
// purpose: a hit must either match the rule or be a known look-alike.
const LOOKS_SECRET = /(token|secret|passw|passcode|api_?key|auth_?key|private_?key|credential|cipher|_pat$|hash)/i

function laterMigrations() {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f) && Number.parseInt(f, 10) > REDACT_MIGRATION)
    .map((f) => ({ f, sql: readFileSync(path.join(MIG_DIR, f), 'utf8') }))
}

/** `secretFields: ['a', 'b']` declarations in tracked src files. */
function declaredSecretFields() {
  const files = execFileSync('git', ['grep', '-l', 'secretFields:', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f && !/\.test\.js$/.test(f))
  const out = []
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), 'utf8')
    for (const m of src.matchAll(/secretFields:\s*\[([^\]]*)\]/g)) {
      for (const n of m[1].matchAll(/['"]([a-z0-9_]+)['"]/gi)) out.push({ f, name: n[1] })
    }
  }
  return out
}

// `public.x`, `"public"."x"`, `public."x"` or bare `x`; the name is group 1.
const SCHEMA_Q = '(?:"?public"?\\.)?'
const NAME_END = '"?(?![a-z0-9_])'

/** Columns a migration adds to an audited table: ADD COLUMN and CREATE TABLE. */
export function addedAuditedColumns(sql, audited = AUDITED_TABLES) {
  const out = []
  const tables = audited.join('|')
  const alter = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${SCHEMA_Q}"?(${tables})${NAME_END}([^;]*);`, 'gi')
  for (const m of sql.matchAll(alter)) {
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi)) {
      out.push({ table: m[1].toLowerCase(), column: c[1].toLowerCase() })
    }
  }
  const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${SCHEMA_Q}"?(${tables})"?\\s*\\(([\\s\\S]*?)\\);`, 'gi')
  for (const m of sql.matchAll(create)) {
    for (const line of m[2].split(',')) {
      const c = line.trim().match(/^"?([a-z0-9_]+)"?\s+[a-z]/i)
      if (c && !/^(constraint|primary|unique|foreign|check)$/i.test(c[1])) out.push({ table: m[1].toLowerCase(), column: c[1].toLowerCase() })
    }
  }
  return out
}

/** Tables a migration attaches the audit trigger to: any CREATE TRIGGER,
 *  under any name, that executes private.log_mutation. */
export function auditTriggerTables(sql) {
  const out = []
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+[\s\S]*?;/gi)) {
    const stmt = m[0]
    if (!/execute\s+(?:function|procedure)\s+"?private"?\s*\.\s*"?log_mutation\b/i.test(stmt)) continue
    const on = stmt.match(/\bon\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/i)
    if (on) out.push(on[1].toLowerCase())
  }
  return out
}

describe('AUDITSECRETS.1 guard', () => {
  it('every declared integration secret field is redacted by the audit rule', () => {
    const fields = declaredSecretFields()
    expect(fields.length).toBeGreaterThan(0) // the scan found the declarations
    const missed = fields.filter(({ name }) => !isAuditSecretKey(name))
    expect(missed).toEqual([])
  })

  it('a later migration adding a secret-looking column to an audited table is covered by the rule', () => {
    const problems = []
    for (const { f, sql } of laterMigrations()) {
      for (const { table, column } of addedAuditedColumns(sql)) {
        if (LOOKS_SECRET.test(column) && !isAuditSecretKey(column) && !KNOWN_NOT_SECRET_NAMES.includes(column)) {
          problems.push(`${f}: ${table}.${column} looks like a credential but private.audit_is_secret_key() does not match it. Rename it, widen the rule (new migration + tests/helpers/audit-secret-keys.js), or add it to KNOWN_NOT_SECRET_NAMES with a reason.`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('a later migration attaching the audit trigger names a table in AUDITED_TABLES', () => {
    const problems = []
    for (const { f, sql } of laterMigrations()) {
      for (const t of auditTriggerTables(sql)) {
        if (!AUDITED_TABLES.includes(t)) problems.push(`${f}: audit_mutation on ${t}: add it to AUDITED_TABLES in tests/helpers/audit-secret-keys.js and check its columns against the rule`)
      }
    }
    expect(problems).toEqual([])
  })

  it('the detectors find what they should (self-test)', () => {
    expect(addedAuditedColumns('ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS shelly_auth_key text;'))
      .toEqual([{ table: 'locations', column: 'shelly_auth_key' }])
    expect(addedAuditedColumns('alter table profiles add column otp_secret text, add column nickname text;'))
      .toEqual([{ table: 'profiles', column: 'otp_secret' }, { table: 'profiles', column: 'nickname' }])
    expect(addedAuditedColumns('ALTER TABLE public.contacts ADD COLUMN api_token text;')).toEqual([])
    expect(auditTriggerTables('create trigger audit_mutation after insert or update or delete\n  on public.xero_connections for each row execute function private.log_mutation();'))
      .toEqual(['xero_connections'])
    // Quoted identifiers (review nit).
    expect(addedAuditedColumns('ALTER TABLE public."locations" ADD COLUMN shelly_secret text;'))
      .toEqual([{ table: 'locations', column: 'shelly_secret' }])
    expect(addedAuditedColumns('alter table "public"."profiles" add column "otp_secret" text;'))
      .toEqual([{ table: 'profiles', column: 'otp_secret' }])
    expect(addedAuditedColumns('ALTER TABLE public."locations_archive" ADD COLUMN api_token text;')).toEqual([])
    // The trigger is found by the function it runs, under any trigger name (review nit).
    expect(auditTriggerTables('CREATE TRIGGER log_changes AFTER UPDATE ON public."xero_connections"\n  FOR EACH ROW EXECUTE PROCEDURE private.log_mutation();'))
      .toEqual(['xero_connections'])
    expect(auditTriggerTables('create trigger audit_mutation after insert on public.foo for each row execute function public.other_fn();'))
      .toEqual([])
    expect(LOOKS_SECRET.test('webhook_signing_secret')).toBe(true)
    expect(isAuditSecretKey('webhook_signing_secret')).toBe(true)
    expect(LOOKS_SECRET.test('nickname')).toBe(false)
  })
})
