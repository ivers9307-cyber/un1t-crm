// ORGCONTACTS.7 (mig 770) — the four membership columns on contact_studios
// (membership_plan / status / since / ended_at) are sync-owned facts:
// derive_contact_studio reads them as a SOURCE, so a second writer would make
// the row its own proof (the C1 class of the ORGCONTACTS final review). The
// un1t sync is the one writer, through setMembershipFacts. This guard pins the
// CALL and the column names in app code; the SQL side (770's backfill, 771's
// parity pass, contact_studios_upsert, the triggers) is pinned by the PGlite
// migration tests. Source-text level over the chain text: a floor, not proof.
// ORGCONTACTS.8 — it also scans scripts/ and supabase/functions/ (a one-off
// script or an edge function is a writer too), and the migration check reads
// every statement that writes contact_studios: UPDATE, INSERT (its column list
// or its ON CONFLICT … DO UPDATE) and MERGE, schema-qualified or not, quoted or
// not, with SQL comments blanked first by the shared quote-aware sqlCode
// (GUARDSTRIP.1: never a regex stripper).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build', '.next'])
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(entry.name) && !/\.test\.(js|jsx|mjs|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const SCANNED_DIRS = ['src', 'shared', 'mobile', 'scripts', 'supabase/functions']
const FILES = SCANNED_DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? sourceFiles(path.join(ROOT, d)) : []))
  .map((file) => ({ key: rel(file), text: fs.readFileSync(file, 'utf8') }))
const MODULE = 'src/lib/contact-studios.js'
// the four fact columns, never locations.membership_source
const FACT_COL = /membership_(plan|status|since|ended_at)\b/
const SYNC = 'src/lib/un1t-online-sync.js'

/** Every write chain on contact_studios in `text`: the text from .from('contact_studios') to the end of its .update/.upsert/.insert argument. */
function contactStudiosWriteChains(text) {
  const out = []
  const re = /\.from\(\s*['"`]contact_studios['"`]\s*\)/g
  let m
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index, m.index + 1200)
    const w = rest.match(/\.(update|upsert|insert)\(/)
    if (!w) continue
    // the argument: balance parentheses from the write's opening paren
    let depth = 0, i = w.index + w[0].length - 1, end = -1
    for (; i < rest.length; i++) {
      if (rest[i] === '(') depth += 1
      else if (rest[i] === ')') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    out.push(rest.slice(0, end + 1))
  }
  return out
}

/**
 * The statements in `sql` that write a membership column on contact_studios:
 * an UPDATE / INSERT INTO / MERGE INTO contact_studios (public.-qualified or
 * not, quoted or not) whose statement text names one of the four columns.
 * Split on ';', so a function body's statements are judged one by one.
 */
function membershipColumnWrites(sql) {
  const target = /\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO)\s+(?:"?public"?\s*\.\s*)?"?contact_studios"?(?![\w"])/i
  return sqlCode(sql).split(';').map((st) => st.trim()).filter((st) => target.test(st) && FACT_COL.test(st))
}

describe('the migration detector catches every write shape', () => {
  const hit = (sql) => membershipColumnWrites(sql).length > 0
  it('flags qualified, unqualified and quoted UPDATEs', () => {
    expect(hit("UPDATE public.contact_studios SET membership_status = 'ended' WHERE contact_id = x;")).toBe(true)
    expect(hit("update contact_studios set membership_since = now();")).toBe(true)
    expect(hit('UPDATE "public"."contact_studios" SET "membership_plan" = NULL;')).toBe(true)
    expect(hit('UPDATE contact_studios cs SET membership_ended_at = now() FROM x WHERE cs.contact_id = x.id;')).toBe(true)
  })
  it('flags an INSERT naming a column, and an ON CONFLICT … DO UPDATE that sets one', () => {
    expect(hit('INSERT INTO contact_studios (contact_id, location_id, membership_plan) VALUES (a, b, c);')).toBe(true)
    expect(hit('INSERT INTO public.contact_studios (contact_id, location_id) SELECT a, b FROM t ON CONFLICT (contact_id, location_id) DO UPDATE SET membership_status = EXCLUDED.membership_status;')).toBe(true)
    expect(hit('MERGE INTO contact_studios cs USING t ON cs.contact_id = t.id WHEN MATCHED THEN UPDATE SET membership_since = t.s;')).toBe(true)
  })
  it('flags a write inside a function body', () => {
    expect(hit("CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; UPDATE contact_studios SET membership_status = 'active'; END $$;")).toBe(true)
  })
  it('ignores reads, other tables, other columns and comments', () => {
    expect(hit('SELECT membership_status FROM contact_studios;')).toBe(false)
    expect(hit("UPDATE contact_studios SET last_seen_at = now();")).toBe(false)
    expect(hit("UPDATE contact_studios_archive SET membership_status = 'x';")).toBe(false)
    expect(hit("UPDATE locations SET membership_source = 'un1t_online';")).toBe(false)
    expect(hit("-- UPDATE contact_studios SET membership_status = 'x';\n/* INSERT INTO contact_studios (membership_plan) */ SELECT 1;")).toBe(false)
  })
})

describe('the membership facts have one writer', () => {
  it('scans every directory that can hold a writer', () => {
    const scanned = new Set(FILES.map((f) => f.key.split('/')[0] === 'supabase' ? 'supabase/functions' : f.key.split('/')[0]))
    for (const d of SCANNED_DIRS) if (fs.existsSync(path.join(ROOT, d))) expect(scanned.has(d)).toBe(true)
  })

  it('setMembershipFacts is called from the un1t sync and nowhere else', () => {
    const callers = FILES.filter((f) => f.key !== MODULE && /\bsetMembershipFacts\s*\(/.test(f.text)).map((f) => f.key)
    expect(callers).toEqual([SYNC])
  })

  it('no contact_studios write outside contact-studios.js names a membership column', () => {
    const offenders = []
    for (const f of FILES) {
      if (f.key === MODULE) continue
      for (const chain of contactStudiosWriteChains(f.text)) if (FACT_COL.test(chain)) offenders.push(`${f.key}: ${chain.slice(0, 80)}`)
    }
    expect(offenders).toEqual([])
  })

  it('inside contact-studios.js only setMembershipFacts (and the column constants) name a membership column', () => {
    const text = FILES.find((f) => f.key === MODULE).text
    const fnStart = text.indexOf('export async function setMembershipFacts')
    const fnEnd = text.indexOf('\n}\n', fnStart) + 3
    expect(fnStart).toBeGreaterThan(0)
    const outside = text.slice(0, fnStart) + text.slice(fnEnd)
    const hits = outside.split('\n').filter((l) => FACT_COL.test(l) && !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    // the constants line and the ROW_COLUMNS template that embeds it
    expect(hits.every((l) => /MEMBERSHIP_FACT_COLUMNS/.test(l))).toBe(true)
  })

  it('no migration after 770 writes a membership column, except 770 (the backfill) and 771 (the parity pass)', () => {
    const dir = path.join(ROOT, 'supabase', 'migrations')
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && parseInt(f, 10) >= 770 && !/^77[01]_/.test(f))
      .filter((f) => membershipColumnWrites(fs.readFileSync(path.join(dir, f), 'utf8')).length > 0)
    expect(offenders).toEqual([])
  })

  it('the detector sees 770 and 771 themselves (so the exemption above is doing work)', () => {
    const dir = path.join(ROOT, 'supabase', 'migrations')
    for (const prefix of ['770_', '771_']) {
      const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix) && n.endsWith('.sql'))
      expect(f, `${prefix} migration`).toBeTruthy()
      expect(membershipColumnWrites(fs.readFileSync(path.join(dir, f), 'utf8')).length).toBeGreaterThan(0)
    }
  })
})
