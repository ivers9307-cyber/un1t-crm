// ORGCONTACTS.7 (mig 770) — the four membership columns on contact_studios
// (membership_plan / status / since / ended_at) are sync-owned facts:
// derive_contact_studio reads them as a SOURCE, so a second writer would make
// the row its own proof (the C1 class of the ORGCONTACTS final review). The
// un1t sync is the one writer, through setMembershipFacts. This guard pins the
// CALL and the column names in app code; the SQL side (770's backfill, 771's
// parity pass, contact_studios_upsert, the triggers) is pinned by the PGlite
// migration tests. Source-text level over the chain text: a floor, not proof.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
const FILES = ['src', 'shared', 'mobile'].flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? sourceFiles(path.join(ROOT, d)) : []))
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

describe('the membership facts have one writer', () => {
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
      .filter((f) => /UPDATE\s+public\.contact_studios[\s\S]{0,400}membership_(plan|status|since|ended_at)\b/i.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
