// BRANDINGBUCKET.1 guard (mig 675). The public 'branding' storage bucket is
// written only by the service role (13 routes, each gated on the studio or
// event the file belongs to) and by upload tokens one of them mints; no
// client policy admits it; and every writer stays inside the bucket's limits,
// src/lib/branding-media.js. Pinned here:
//
//  1. Browser and phone code calls nothing on `.storage.from('branding')`
//     but uploadToSignedUrl (src/lib/landing-media-upload.js, with a token
//     /api/landing-page-settings/media/signed-upload minted: the Storage API
//     runs it as superuser, so it needs no policy) and getPublicUrl (none
//     today). Because 'branding' is an everyday word in this codebase
//     (settings tabs, /api/settings/branding, the tenant wizard), mentions
//     are not policed as bare words (C92's rule); instead, in client code:
//     every `.from('branding')` must be IMMEDIATELY followed by
//     .getPublicUrl( / .uploadToSignedUrl( (so a handle in a variable, a
//     destructured `storage`, bracket access or a TS generic cannot hide a
//     write); every /storage/v1/…branding REST path must be a public read, a
//     public render or a signed upload (so a raw REST upload, list or sign
//     fails); a Storage request body naming it as `bucketId` fails (a raw
//     move/copy); and a constant holding the name (defined anywhere in the
//     app) never reaches `.from(…)` in client code. Client-bound code =
//     shared/, mobile/, desktop/src, and every src/ file that is 'use client'
//     (after any header comment), names createBrowserClient, calls
//     createAuthClient() or holds the anon key.
//  2. Every OTHER src/ file that names the bucket in `.from(…)` is one of the
//     known writers, uses createServerClient() and its session gate; every
//     MIME type a writer names is in BRANDING_BUCKET_MIME_TYPES and every
//     `N * 1024 * 1024` cap is at most BRANDING_BUCKET_MAX_BYTES (Storage
//     would refuse what the route accepted); the browser uploader holds
//     video to BRANDING_BUCKET_MAX_BYTES.
//  3. After replaying every migration (scripts/check-rls-restrictive.mjs
//     netPolicyState), no PERMISSIVE storage.objects policy of any command
//     that reaches anon, authenticated or PUBLIC admits the bucket: it names
//     the bucket, or it has no positive `bucket_id = '<literal>'` restriction.
//     SELECT counts: it is what would arm an UPDATE or DELETE policy.
//  4. Every migration from SCAN_FROM on (a lower number can merge later) is
//     checked on its own for the same thing, including a CREATE POLICY run
//     from EXECUTE '…', and for an ALTER POLICY on storage.objects that names
//     the bucket.
//  5. The LATEST migration that writes the bucket row sets file_size_limit
//     to BRANDING_BUCKET_MAX_BYTES and allowed_mime_types to
//     BRANDING_BUCKET_MIME_TYPES, and every migration from SCAN_FROM on, on
//     its own, never makes the bucket private and sets no other limit.
//  The one exemption from 3-5 is a rollback migration named
//  `<NNN>_brandingbucket1_rollback.sql`, and only for the three statements
//  that re-create the 30 Sep policies with their exact prod text; anything
//  else in that file is checked.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; no range taken where JSX text starts), SQL comments by one
// quote- and dollar-aware pass that pairs each $tag$ with its own closing
// tag (sqlCode): the shared tests/helpers/js-code.js and sql-code.js
// (GUARDSTRIP.1, C74).
// A floor, not a proof: a bucket name built at runtime (`brand${x}`, a join,
// an object property defined outside client code), SQL built at runtime or a
// policy created by hand on prod is invisible; mig 675's self-check covers
// the live catalog at apply time. champ-app, champ-bridge, un1t-pi,
// un1t-platform, un1t-sentinel and un1t-finance-agent never name the bucket
// (C100 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments, stripCommentsOfFile as codeOfFile } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'
import { BRANDING_BUCKET_MIME_TYPES, BRANDING_BUCKET_MAX_BYTES } from '../src/lib/branding-media.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUCKET_MIGRATION = 675
// Scanned from 631, not 675: migration numbers are reserved ahead of time and
// a lower number can merge later (631 is the HELD #1774, 663 #1849, 674 C94
// when 675 was written).
const SCAN_FROM = 631
const BUCKET = 'branding'
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_brandingbucket1_rollback\.sql$/
const CLIENT_OK = new Set(['uploadToSignedUrl', 'getPublicUrl'])
const CLIENT_UPLOADER = 'src/lib/landing-media-upload.js'
// Every server file that names the bucket, with the session gate it calls.
// A new one fails 'the server files that name the bucket are exactly the known
// writers' until someone reviews its gate and adds it here.
const WRITERS = {
  'src/app/api/settings/branding/upload/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/hero-image/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/hero-video/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/gallery-photo/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/pillar-photo/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/media/route.js': 'getCurrentUser',
  'src/app/api/landing-page-settings/media/signed-upload/route.js': 'getCurrentUser',
  'src/app/api/chooser-settings/tile-image/route.js': 'getCurrentUser',
  'src/app/api/events/[id]/hero/route.js': 'getCurrentUser',
  'src/app/api/events/[id]/logo/route.js': 'getCurrentUser',
  'src/app/api/host/events/[id]/hero/route.js': 'getCurrentHost',
  'src/app/api/me/signature-photo/route.js': 'getCurrentUser',
  'src/app/api/staff/[id]/permanent/route.js': 'getCurrentUser',
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// ── client code ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code.trimStart()) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
export const isClientFile = (text, file) => isClientCode(stripComments(text, file))

// The desktop (Tauri) shell's own pages are client code too; an .html file
// is read raw (the TypeScript parser cannot read it, so nothing is stripped).
const DESKTOP = path.join(ROOT, 'desktop/src')
const desktopFiles = () => (existsSync(DESKTOP) ? readdirSync(DESKTOP, { recursive: true }) : [])
  .map((f) => path.join(DESKTOP, f))
  .filter((f) => !f.split(path.sep).includes('node_modules') && statSync(f).isFile() &&
    /\.(html?|m?js|jsx|ts|tsx)$/.test(f) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(f))
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...desktopFiles()]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

const STORAGE_CALL = /\.\s*storage\s*\??\.\s*from\(\s*['"`]branding['"`]\s*\)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g

/** Every method called on the bucket in already-stripped code. */
const bucketCallsIn = (code) => [...code.matchAll(STORAGE_CALL)].map((m) => m[1])
/** Every bucket call a client may not make, in `text` (comments excluded). */
export const forbiddenBucketCalls = (text, file) =>
  bucketCallsIn(stripComments(text, file)).filter((m) => !CLIENT_OK.has(m))

// The call detector only sees `.storage.from('branding').<method>(`. These
// three tokens catch what it cannot, without reading 'branding' as a bare word.
const FROM_BUCKET = /\.\s*from\(\s*(['"`])branding\1\s*\)/g
const NAMES_BUCKET = /\.\s*from\(\s*(['"`])branding\1\s*\)/
const FROM_FOLLOW_OK = /^\s*\??\.\s*(?:uploadToSignedUrl|getPublicUrl)\s*\(/
const STORAGE_PATH = /\/storage\/v1\/(?:[\w-]+\/)*branding(?![\w-])/g
const STORAGE_PATH_OK = /^\/storage\/v1\/(?:object\/public|object\/upload\/sign|render\/image\/public)\/branding$/
const BUCKET_ID_PROP = /\bbucket(?:_?id|_?name)?['"`]?\s*:\s*(['"`])branding\1/gi
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names of variables initialised to the bucket name, in already-stripped code. */
export function bucketConstantsIn(code) {
  return [...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])branding\2/g)].map((m) => m[1])
}

let BUCKET_CONSTS = null
function bucketConstants() {
  if (BUCKET_CONSTS) return BUCKET_CONSTS
  const all = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...desktopFiles()]
  BUCKET_CONSTS = [...new Set(all.flatMap((f) => bucketConstantsIn(codeOfFile(f))))]
  return BUCKET_CONSTS
}

/** Every use of the bucket in already-stripped client code that is not an allowed call, public read path or signed-upload path. */
export function strayBucketUses(code, consts = []) {
  const line = (i) => code.slice(0, i).split('\n').length
  const out = []
  for (const m of code.matchAll(FROM_BUCKET)) {
    if (!FROM_FOLLOW_OK.test(code.slice(m.index + m[0].length))) {
      out.push(`line ${line(m.index)}: .from('branding') not followed by .getPublicUrl( or .uploadToSignedUrl(`)
    }
  }
  for (const m of code.matchAll(STORAGE_PATH)) {
    if (!STORAGE_PATH_OK.test(m[0])) out.push(`line ${line(m.index)}: a Storage REST path on the bucket that is not a public read, render or signed upload`)
  }
  for (const m of code.matchAll(BUCKET_ID_PROP)) out.push(`line ${line(m.index)}: the bucket named as a Storage request's bucket`)
  for (const name of new Set(consts)) {
    const re = new RegExp(String.raw`\.\s*from\(\s*(?:[\w$]+\s*\??\.\s*)*${reEscape(name)}\s*\)`, 'g')
    for (const m of code.matchAll(re)) out.push(`line ${line(m.index)}: .from(${name}), a constant holding the bucket name`)
  }
  return out
}

// ── server writers ───────────────────────────────────────────────────────
const MIME_LITERAL = /(['"`])((?:image|video|audio|application|text|font|model)\/[\w.+-]+)\1/g
const MIB_CAP = /\b(\d+(?:\.\d+)?)\s*\*\s*1024\s*\*\s*1024\b/g
/** MIME types named in already-stripped code. */
export const mimeLiteralsIn = (code) => [...new Set([...code.matchAll(MIME_LITERAL)].map((m) => m[2]))].sort()
/** `N * 1024 * 1024` byte caps in already-stripped code. */
export const mibCapsIn = (code) => [...code.matchAll(MIB_CAP)].map((m) => Math.round(Number(m[1]) * 1024 * 1024))

// ── migrations ───────────────────────────────────────────────────────────

const CLIENT_ROLES = ['anon', 'authenticated', 'public']
// A positive single-bucket restriction; '' covers a policy inside EXECUTE '…'.
const BUCKET_LITERAL = /\bbucket_id\s*=\s*'+[^']+'/i

/**
 * Does a PERMISSIVE policy reaching a client role admit the bucket? It does
 * when its expression names the bucket, or restricts no bucket at all.
 * (Same rule as mig 675's self-check 3; `bucket_id = 'x' OR true` fools both.)
 */
export function admitsBucket({ permissive, roles, expr }) {
  if (permissive !== 'PERMISSIVE') return false
  if (!roles.some((r) => CLIENT_ROLES.includes(r))) return false
  return expr.includes(BUCKET) || !BUCKET_LITERAL.test(expr)
}

// storage.objects, or bare `objects` (resolved through a search_path that
// includes storage); another schema's `objects` is not matched.
const OBJECTS = String.raw`(?:"?storage"?\s*\.\s*)?"?objects"?`
const CREATE_RE = new RegExp(String.raw`\bcreate\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+(?:table\s+)?${OBJECTS}(?=[\s;'])([^;]*)`, 'gi')
const ALTER_RE = new RegExp(String.raw`\balter\s+policy\s+(?:"[^"]+"|\S+)\s+on\s+${OBJECTS}(?=[\s;'])([^;]*)`, 'gi')

/** Every statement in `sql` that would let a client session reach the bucket. */
export function bucketReopeners(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const m of code.matchAll(CREATE_RE)) {
    const body = m[1]
    const to = body.match(/(?:^|\s)to\s+([\w",\s]+?)(?=\busing\b|\bwith\b|'|$)/i)
    const roles = to ? to[1].split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase()).filter(Boolean) : ['public']
    const permissive = /\bas\s+restrictive\b/i.test(body) ? 'RESTRICTIVE' : 'PERMISSIVE'
    if (admitsBucket({ permissive, roles, expr: body })) hits.push(m[0].trim())
  }
  for (const m of code.matchAll(ALTER_RE)) if (m[1].includes(BUCKET)) hits.push(m[0].trim())
  return hits
}

const EXPECTED_SIZE = BRANDING_BUCKET_MAX_BYTES
const EXPECTED_MIMES = [...BRANDING_BUCKET_MIME_TYPES].sort()

/**
 * Top-level statements that write the bucket row (DO/function bodies and
 * comments removed): an UPDATE or INSERT on storage.buckets that names the
 * bucket, or an UPDATE with no WHERE (it writes every bucket, this one too).
 */
export function bucketRowWrites(sql) {
  const code = sqlCode(sql).replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, ' ')
  return code.split(';').map((s) => s.trim())
    .filter((s) => /^(update\s+"?storage"?\s*\.\s*"?buckets"?|insert\s+into\s+"?storage"?\s*\.\s*"?buckets"?)(?=[\s(]|$)/i.test(s) &&
      (s.includes(`'${BUCKET}'`) || (/^update\b/i.test(s) && !/\bwhere\b/i.test(s))))
}

/** Split on top-level commas (not inside '…', "…", (…) or […]). */
function splitTop(text) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const c of text) {
    if (quote) { if (c === quote) quote = null; cur += c; continue }
    if (c === "'" || c === '"') quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const unquote = (id) => id.trim().replace(/^"|"$/g, '').toLowerCase()

/** `col = expr, …` → Map(col → expr). */
function assignments(setClause) {
  const out = new Map()
  for (const a of splitTop(setClause)) {
    const m = a.match(/^("[^"]+"|[\w$]+)\s*=\s*([\s\S]+)$/)
    if (m) out.set(unquote(m[1]), m[2].trim())
  }
  return out
}

/** What a bucket-row write sets, as column → expression text. */
function bucketColumns(stmt) {
  const cols = new Map()
  const ins = stmt.match(/^insert\s+into\s+\S+\s*\(([^)]*)\)\s*values\s*\(([\s\S]*?)\)\s*(on\s+conflict\b[\s\S]*)?$/i)
  if (ins) {
    const names = splitTop(ins[1]).map(unquote)
    const values = splitTop(ins[2])
    names.forEach((n, i) => cols.set(n, values[i] ?? ''))
    // A new row takes the column default, and storage.buckets.public defaults to false.
    if (!cols.has('public')) cols.set('public', 'false')
    const upsert = (ins[3] || '').match(/\bdo\s+update\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|$)/i)
    if (upsert) for (const [k, v] of assignments(upsert[1])) cols.set(k, v)
    return cols
  }
  const upd = stmt.match(/\bset\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|\bfrom\b|$)/i)
  if (upd) for (const [k, v] of assignments(upd[1])) cols.set(k, v)
  if (/^insert\b/i.test(stmt) && !ins) cols.set('public', 'unreadable')
  return cols
}

/**
 * The limits a bucket-row write sets: { sizeLimit, mimes, makesPrivate }.
 * undefined = not set here; null = set to NULL (no limit); 'unreadable' = set
 * to something this cannot evaluate (which fails the check: write a literal).
 */
export function bucketLimits(stmt) {
  const cols = bucketColumns(stmt)
  const bare = (v) => v.replace(/::\s*[\w\s[\]]+$/, '').trim()
  let sizeLimit
  if (cols.has('file_size_limit')) {
    const v = bare(cols.get('file_size_limit'))
    sizeLimit = /^null$/i.test(v) ? null : /^\d+$/.test(v) ? Number(v) : 'unreadable'
  }
  let mimes
  if (cols.has('allowed_mime_types')) {
    const v = bare(cols.get('allowed_mime_types'))
    const arr = v.match(/^array\s*\[([^\]]*)\]$/i)
    const lit = v.match(/^'\{([^}']*)\}'$/)
    if (/^null$/i.test(v)) mimes = null
    else if (arr && splitTop(arr[1]).every((e) => /^'[^']+'(::\s*text)?$/i.test(e))) mimes = splitTop(arr[1]).map((e) => e.match(/^'([^']+)'/)[1]).sort()
    else if (lit) mimes = lit[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).sort()
    else mimes = 'unreadable'
  }
  const pub = cols.has('public') ? bare(cols.get('public')) : null
  return { sizeLimit, mimes, makesPrivate: pub !== null && !/^true$/i.test(pub) }
}

/** Every way the bucket-row writes in `sql` break the bucket (private, or limits out of step with branding-media.js). */
export function bucketRowProblems(sql) {
  const problems = []
  for (const s of bucketRowWrites(sql)) {
    const l = bucketLimits(s)
    if (l.makesPrivate) problems.push(`makes the bucket private: ${s}`)
    if (l.sizeLimit !== undefined && l.sizeLimit !== EXPECTED_SIZE) problems.push(`file_size_limit ${l.sizeLimit}, expected ${EXPECTED_SIZE}: ${s}`)
    if (l.mimes !== undefined && JSON.stringify(l.mimes) !== JSON.stringify(EXPECTED_MIMES)) problems.push(`allowed_mime_types ${JSON.stringify(l.mimes)}, expected ${JSON.stringify(EXPECTED_MIMES)}: ${s}`)
  }
  return problems
}

// A rollback migration (`<NNN>_brandingbucket1_rollback.sql`) may restore the
// 30 Sep state and nothing more: re-create the three live policies with their
// exact prod text. Only those statements are exempt; everything else in the
// file is checked like any other migration. (675 changes no limit, so there
// is no bucket-row statement to exempt.)
const ROLLBACK_POLICIES = new Set(['Owners can upload branding', 'Owners can update branding', 'Owners can delete branding'])
const OWNER_EXPR = String.raw`\(\(?bucket_id = 'branding'\)? and "?private"?\."?is_owner"?\(\)\)`
const ROLLBACK_OK = [
  new RegExp(String.raw`^create policy "owners can upload branding" on "?storage"?\."?objects"? (?:as permissive )?for insert to "?authenticated"? with check ${OWNER_EXPR}$`),
  new RegExp(String.raw`^create policy "owners can update branding" on "?storage"?\."?objects"? (?:as permissive )?for update to "?authenticated"? using ${OWNER_EXPR}$`),
  new RegExp(String.raw`^create policy "owners can delete branding" on "?storage"?\."?objects"? (?:as permissive )?for delete to "?authenticated"? using ${OWNER_EXPR}$`),
]
const normStmt = (stmt) => stmt.replace(/\s+/g, ' ').trim().toLowerCase().replace(/::text\b/g, '')
  .replace(/\s*=\s*/g, ' = ').replace(/\s*,\s*/g, ', ').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*\.\s*/g, '.')

/** A rollback file's SQL with only the exempt statements removed (comments blanked). */
export function rollbackRemainder(sql) {
  return sqlCode(sql).split(';').map((stmt) => (ROLLBACK_OK.some((re) => re.test(normStmt(stmt))) ? '' : stmt)).join(';')
}
/** A migration's SQL as the per-file checks read it. */
const scanText = (file) => {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
  return ROLLBACK_FILE.test(file) ? rollbackRemainder(sql) : sql
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

describe('client code never writes the branding bucket (BRANDINGBUCKET.1, mig 675)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police, and sees the signed upload (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      CLIENT_UPLOADER,
      'src/components/LandingPageSettingsForm.jsx',
      'src/components/landing-page/HeroMediaTools.jsx',
    ]))
    if (existsSync(DESKTOP)) expect(names).toContain('desktop/src/index.html')
    for (const w of Object.keys(WRITERS)) expect(names).not.toContain(w)
    const seen = clientFiles().flatMap((f) => bucketCallsIn(codeOfFile(f)).map((m) => `${rel(f)}: ${m}`))
    expect(seen).toEqual([`${CLIENT_UPLOADER}: uploadToSignedUrl`])
  })

  it('no browser or phone file calls anything on the bucket but getPublicUrl / uploadToSignedUrl', () => {
    const offenders = []
    for (const f of clientFiles()) {
      for (const m of bucketCallsIn(codeOfFile(f))) if (!CLIENT_OK.has(m)) offenders.push(`${rel(f)}: ${m}`)
    }
    expect(offenders, 'upload through the service-role routes (or a signed URL one of them mints); mig 675 refuses client writes').toEqual([])
  })

  it('the detector catches every client write shape and ignores the allowed ones and comments', () => {
    const bad = `
      await supabase.storage.from('branding').upload(p, file)
      await supabase.storage.from("branding")
        .remove([p])
      await supabase.storage?.from(\`branding\`)?.update(p, file)
      await supabase . storage . from('branding') . move(a, b)
      await supabase.storage.from('branding').list('')
      await supabase.storage.from('branding').createSignedUploadUrl(p)`
    expect(forbiddenBucketCalls(bad)).toEqual(['upload', 'remove', 'update', 'move', 'list', 'createSignedUploadUrl'])
    const ok = `
      const url = supabase.storage.from('branding').getPublicUrl(path).data.publicUrl
      await supabase.storage.from('branding').uploadToSignedUrl(p, t, file, { contentType })
      // await supabase.storage.from('branding').remove([p])
      /* await supabase.storage.from('branding').upload(p, f) */
      await supabase.storage.from('tv-content').upload(p, f)
      await fetch('/api/settings/branding/upload', { method: 'POST', body: fd })`
    expect(forbiddenBucketCalls(ok)).toEqual([])
  })

  it('every use of the bucket in browser or phone code is an allowed call or a public/signed path', () => {
    const consts = bucketConstants()
    const offenders = clientFiles().flatMap((f) => strayBucketUses(codeOfFile(f), consts).map((u) => `${rel(f)}: ${u}`))
    expect(offenders, "in client code name the bucket only as .storage.from('branding').getPublicUrl(…)/.uploadToSignedUrl(…) or a /storage/v1/object/public/branding/ URL (mig 675)").toEqual([])
  })

  it('the stray-use detector catches the shapes the call detector cannot see', () => {
    const sneaky = [
      ["const b = supabase.storage.from('branding')\nawait b.remove([p])", 'x.js'],
      ["const { storage } = supabase\nawait storage.from('branding').remove([p])", 'x.js'],
      ["await supabase.storage.from('branding')['remove']([p])", 'x.js'],
      ["await supabase.storage.from('branding').upload<Blob>(p, f)", 'x.ts'],
      ["const BRAND_BUCKET = 'branding'\nawait supabase.storage.from(BRAND_BUCKET).remove([p])", 'x.js'],
      ["await fetch(`${url}/storage/v1/object/branding/${p}`, { method: 'POST', body: f })", 'x.js'],
      ["await fetch(`${url}/storage/v1/object/branding/${p}`, { method: 'PUT', headers: { 'x-upsert': 'true' }, body: f })", 'x.js'],
      ["await fetch(url + '/storage/v1/object/list/branding', { method: 'POST', body: '{}' })", 'x.js'],
      ["await fetch(url + '/storage/v1/object/sign/branding/' + p, { method: 'POST' })", 'x.js'],
      ["await fetch(`${url}/storage/v1/object/move`, { method: 'POST', body: JSON.stringify({ bucketId: 'branding', sourceKey: a, destinationKey: b }) })", 'x.js'],
      ["await supabase.storage.from('branding').getPublicUrl(p)\nawait supabase.storage.from('branding').move(a, b)", 'x.js'],
    ]
    for (const [text, file] of sneaky) {
      const code = stripComments(text, file)
      expect(strayBucketUses(code, bucketConstantsIn(code)), text).not.toEqual([])
    }
    // A constant defined elsewhere (a server lib, a shared config) and used here.
    const imported = "import { BRAND_BUCKET } from '@/lib/b'\nawait supabase.storage.from(BRAND_BUCKET).remove([p])\nawait supabase.storage.from(cfg.BRAND_BUCKET).list('')"
    expect(strayBucketUses(stripComments(imported, 'x.js'), ['BRAND_BUCKET'])).toHaveLength(2)
    expect(bucketConstantsIn("export const BRAND_BUCKET = 'branding'\nlet b2 = `branding`\nconst other = 'tv-content'"))
      .toEqual(['BRAND_BUCKET', 'b2'])
    const ok = [
      "return supabase.storage.from('branding').getPublicUrl(path).data.publicUrl",
      "const { data } = supabase.storage\n  .from('branding')\n  .getPublicUrl(p)",
      "await supabase.storage.from(\"branding\")?.uploadToSignedUrl(p, t, f)",
      "const { error } = await supabase.storage\n      .from('branding')\n      .uploadToSignedUrl(j.path, j.token, toUpload, { contentType: toUpload.type })",
      'return `${SUPA_URL}/storage/v1/object/public/branding/${path}`',
      "const src = base + '/storage/v1/render/image/public/branding/' + p + '?width=640'",
      "await fetch(`${url}/storage/v1/object/upload/sign/branding/${p}?token=${t}`, { method: 'PUT', body: bytes })",
      "// await supabase.storage.from('branding').remove([p])",
      "await fetch('/api/settings/branding/upload', { method: 'POST', body: fd })",
      "await fetch('/api/public/branding')",
      "const tabs = [{ key: 'branding', label: 'Branding' }]\nif (active === 'branding') show()",
      "await supabase.storage.from(OTHER_BUCKET).remove([p])",
    ]
    for (const text of ok) expect(strayBucketUses(stripComments(text, 'x.js'), ['BRAND_BUCKET']), text).toEqual([])
  })

  it("a '/*' in a string or JSX text hides nothing", () => {
    expect(forbiddenBucketCalls("const a = 'image/*'\nsupabase.storage.from('branding').upload(p, f)\nconst b = '*/'\n"))
      .toEqual(['upload'])
    expect(forbiddenBucketCalls("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.storage.from('branding').remove([p])}<p>end */</p></div>\n}\n"))
      .toEqual(['remove'])
  })
})

describe('every server writer is known, service-role, gated and inside the bucket limits (BRANDINGBUCKET.1)', { timeout: 120_000 }, () => {
  it('the server files that name the bucket are exactly the known writers', () => {
    const client = new Set(clientFiles())
    const found = walk(path.join(ROOT, 'src'))
      .filter((f) => !client.has(f) && NAMES_BUCKET.test(codeOfFile(f)))
      .map(rel).sort()
    expect(found, 'a new server file writes the branding bucket: check it gates on the studio or event the file belongs to, then add it to WRITERS').toEqual(Object.keys(WRITERS).sort())
  })

  it('each writer uses the service role behind its session gate', () => {
    for (const [f, gate] of Object.entries(WRITERS)) {
      const code = codeOfFile(path.join(ROOT, f))
      expect(code, f).toMatch(/\bcreateServerClient\(\s*\)/)
      expect(code, f).toMatch(new RegExp(String.raw`\b${gate}\s*\(`))
    }
  })

  it('no writer accepts a type the bucket refuses, or caps above its size limit', () => {
    const problems = []
    for (const f of Object.keys(WRITERS)) {
      const code = codeOfFile(path.join(ROOT, f))
      for (const m of mimeLiteralsIn(code)) if (!BRANDING_BUCKET_MIME_TYPES.includes(m)) problems.push(`${f}: ${m} is not in BRANDING_BUCKET_MIME_TYPES`)
      for (const cap of mibCapsIn(code)) if (cap > BRANDING_BUCKET_MAX_BYTES) problems.push(`${f}: cap ${cap} > BRANDING_BUCKET_MAX_BYTES`)
    }
    expect(problems, 'widen src/lib/branding-media.js AND the bucket (a migration) in the same PR, or Storage refuses what the route accepts').toEqual([])
    // Not vacuous: the logo route's ICO/SVG list and the media route's two caps are read.
    const logo = codeOfFile(path.join(ROOT, 'src/app/api/settings/branding/upload/route.js'))
    expect(mimeLiteralsIn(logo)).toEqual(expect.arrayContaining(['image/svg+xml', 'image/vnd.microsoft.icon']))
    expect(mibCapsIn(codeOfFile(path.join(ROOT, 'src/app/api/landing-page-settings/media/route.js')))).toEqual([5 * 1024 * 1024, 25 * 1024 * 1024])
    expect(mimeLiteralsIn("const T = new Set(['image/gif'])")).toEqual(['image/gif'])
    expect(mibCapsIn('const MAX = 250 * 1024 * 1024')).toEqual([250 * 1024 * 1024])
  })

  it('the browser uploader holds tap-to-play video to the bucket ceiling', () => {
    const code = codeOfFile(path.join(ROOT, CLIENT_UPLOADER))
    expect(code).toMatch(/import\s*\{[^}]*\bBRANDING_BUCKET_MAX_BYTES\b[^}]*\}\s*from\s*['"]\.\/branding-media['"]/)
    expect(code).toMatch(/\bMAX_VIDEO_OUTPUT_BYTES\s*=\s*BRANDING_BUCKET_MAX_BYTES\b/)
  })
})

describe('migrations keep the bucket closed to clients and its limits in step (mig 675)', () => {
  it('mig 675 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${BUCKET_MIGRATION}_`))).toBe(true)
  })

  it('after every migration, no client policy on storage.objects admits the bucket', () => {
    const net = netPolicyState(MIGRATIONS)
      .filter((p) => p.table === 'storage.objects' && !(ROLLBACK_FILE.test(p.file) && ROLLBACK_POLICIES.has(p.name)))
    expect(net.length).toBeGreaterThan(2)   // not vacuous: the three contracts reads, the 403 deny
    const admitting = net
      .filter((p) => admitsBucket({ permissive: p.permissive, roles: p.roles, expr: `${p.using ?? ''} ${p.check ?? ''}` }))
      .map((p) => `${p.name} (${p.file})`)
    expect(admitting, 'a client policy admits the branding bucket (mig 675)').toEqual([])
    const names = net.map((p) => p.name)
    for (const n of ROLLBACK_POLICIES) expect(names).not.toContain(n)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client policy that admits the bucket', (file) => {
    expect(bucketReopeners(scanText(file)),
      `${file} lets a client session write or list the branding bucket (mig 675). Upload through a service-role route instead`).toEqual([])
  })

  it('the latest write to the bucket row is mig 675, keeps it public and matches src/lib/branding-media.js', () => {
    const writes = migrationFiles().flatMap((f) => bucketRowWrites(scanText(f)).map((s) => ({ f, s })))
    expect(writes.length).toBeGreaterThan(4)   // mig 013's INSERT, 248, 250, 252, 675's UPDATE
    const last = writes.at(-1)
    expect(last.f.startsWith(`${BUCKET_MIGRATION}_`), last.f).toBe(true)
    expect(bucketLimits(last.s), `${last.f} must set the bucket's limits from src/lib/branding-media.js`).toEqual({
      sizeLimit: EXPECTED_SIZE,
      mimes: EXPECTED_MIMES,
      makesPrivate: false,
    })
  })

  it.each(later)('%s: never makes the bucket private, and any limit it sets matches branding-media.js', (file) => {
    // Per file, not only the latest write: a lower-numbered file that merges
    // after 675 runs on prod AFTER it, yet sorts before it here.
    expect(bucketRowProblems(scanText(file)),
      `${file} breaks the branding bucket: keep it public (pages and emails load it by URL) and set its limits from src/lib/branding-media.js`).toEqual([])
  })

  it('the bucket-row check catches every form', () => {
    const bad = [
      "UPDATE storage.buckets SET public = false WHERE id = 'branding';",
      "UPDATE \"storage\".\"buckets\" SET \"public\" = false WHERE id = 'branding';",
      'UPDATE storage.buckets SET public = false;',
      "UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id = 'branding';",
      "UPDATE storage.buckets SET file_size_limit = 52428800 WHERE id = 'branding';",
      "UPDATE storage.buckets SET file_size_limit = 200 * 1024 * 1024 WHERE id = 'branding';",
      "UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/png'] WHERE id = 'branding';",
      "UPDATE storage.buckets SET allowed_mime_types = '{image/png}' WHERE id = 'branding';",
      "INSERT INTO storage.buckets (id, name) VALUES ('branding', 'branding') ON CONFLICT (id) DO NOTHING;",
      "INSERT INTO storage.buckets (id, public, name) VALUES ('branding', false, 'branding');",
      "INSERT INTO storage.buckets (id, name, public) VALUES ('branding', 'branding', true) ON CONFLICT (id) DO UPDATE SET file_size_limit = NULL;",
    ]
    for (const sql of bad) expect(bucketRowProblems(sql), sql).not.toEqual([])
    const mimeArray = `ARRAY[${EXPECTED_MIMES.map((m) => `'${m}'`).join(', ')}]`
    const ok = [
      `UPDATE storage.buckets SET public = true, file_size_limit = ${EXPECTED_SIZE}, allowed_mime_types = ${mimeArray} WHERE id = 'branding';`,
      `UPDATE storage.buckets SET allowed_mime_types = ${mimeArray}::text[] WHERE id = 'branding';`,
      `UPDATE storage.buckets SET allowed_mime_types = '{${[...EXPECTED_MIMES].reverse().join(',')}}' WHERE id = 'branding';`,
      "UPDATE storage.buckets SET public = true WHERE id = 'branding';",
      "UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'tv-content';",
      "INSERT INTO storage.buckets (id, name, public) VALUES ('branding', 'branding', TRUE) ON CONFLICT (id) DO NOTHING;",
      "-- UPDATE storage.buckets SET public = false WHERE id = 'branding';",
    ]
    for (const sql of ok) expect(bucketRowProblems(sql), sql).toEqual([])
  })

  it('the policy detector catches every form', () => {
    const bad = [
      "CREATE POLICY \"Owners can upload branding\" ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());",
      "create policy x on storage.objects for delete to anon, authenticated using (bucket_id = 'branding'::text);",
      "CREATE POLICY \"Public read access for branding\" ON storage.objects FOR SELECT USING (bucket_id = 'branding');",
      "CREATE POLICY \"List branding\" ON \"storage\".\"objects\" FOR SELECT TO authenticated USING (bucket_id = 'branding');",
      'CREATE POLICY anyone ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY anyone ON storage.objects WITH CHECK (true);',
      "CREATE POLICY neg ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id <> 'tv-content');",
      "CREATE POLICY own ON storage.objects FOR UPDATE TO authenticated USING (owner = auth.uid());",
      `DO $$ BEGIN EXECUTE 'CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ''branding'')'; END $$;`,
      "ALTER POLICY \"Master reads all signed PDFs\" ON storage.objects USING (bucket_id IN ('contracts', 'branding'));",
      "SELECT '/*';\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');\nSELECT '*/';",
      "-- a note with /* in it\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);\n-- */",
      // Unqualified: storage.objects under a search_path that includes storage.
      "SET search_path = storage, public;\nCREATE POLICY p ON objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');",
      "ALTER POLICY \"Master reads all signed PDFs\" ON \"objects\" USING (bucket_id IN ('contracts', 'branding'));",
      // A $$ body closed before a later literal: the pairing must not flip.
      "DO $$ BEGIN PERFORM 1; END $$;\nSELECT $$ /* $$;\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');\nSELECT $$ */ $$;",
    ]
    for (const sql of bad) expect(bucketReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      "CREATE POLICY \"Master reads all signed PDFs\" ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'contracts'::text) AND private.auth_is_master());",
      "CREATE POLICY wa ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');",
      "CREATE POLICY \"private buckets deny client\" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id NOT IN ('branding'));",
      "CREATE POLICY svc ON storage.objects FOR ALL TO service_role USING (true);",
      'DROP POLICY IF EXISTS "Owners can upload branding" ON storage.objects;',
      "CREATE POLICY x ON public.company_settings FOR SELECT TO authenticated USING (true);",
      "-- CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');",
      "/* CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true); */",
      "ALTER POLICY \"Master reads all signed PDFs\" ON storage.objects TO authenticated;",
      'CREATE POLICY x ON public.objects FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY x ON objects_log FOR INSERT TO authenticated WITH CHECK (true);',
    ]
    for (const sql of ok) expect(bucketReopeners(sql), sql).toEqual([])
  })

  it('reads the bucket row writes and their limits', () => {
    const sql = `UPDATE storage.buckets SET public = true, file_size_limit = 209715200,
      allowed_mime_types = ARRAY['image/png', 'image/jpeg'] WHERE id = 'branding';
      DO $$ BEGIN PERFORM 1 FROM storage.buckets WHERE id = 'branding'; END $$;
      UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'tv-content';`
    const writes = bucketRowWrites(sql)
    expect(writes).toHaveLength(1)
    expect(bucketLimits(writes[0])).toEqual({ sizeLimit: 209715200, mimes: ['image/jpeg', 'image/png'], makesPrivate: false })
    expect(bucketLimits("UPDATE storage.buckets SET public = false WHERE id = 'branding'").makesPrivate).toBe(true)
    expect(bucketLimits("INSERT INTO storage.buckets (id, name, public) VALUES ('branding', 'branding', false)").makesPrivate).toBe(true)
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('676_brandingbucket1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('676_branding_bucket_reopen.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('676_tvbucket1_rollback.sql')).toBe(false)
  })

  it('…and only for the three statements that restore the 30 Sep policies; anything else in it is still checked', () => {
    // The C100 plan's rollback record (Task 6 Step 7), verbatim.
    const ROLLBACK = `BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE POLICY "Owners can upload branding" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());
CREATE POLICY "Owners can update branding" ON storage.objects
  FOR UPDATE TO authenticated USING ((bucket_id = 'branding'::text) AND private.is_owner());
CREATE POLICY "Owners can delete branding" ON storage.objects
  FOR DELETE TO authenticated USING ((bucket_id = 'branding'::text) AND private.is_owner());
COMMIT;`
    const clean = (sql) => ({ reopeners: bucketReopeners(rollbackRemainder(sql)), rows: bucketRowProblems(rollbackRemainder(sql)) })
    expect(clean(ROLLBACK)).toEqual({ reopeners: [], rows: [] })
    // The same statement spelt differently.
    expect(clean(`create policy "Owners can upload branding" on "storage"."objects" for insert to authenticated
      with check ( bucket_id='branding'::text AND private.is_owner() );`)).toEqual({ reopeners: [], rows: [] })
    // Anything beyond those three still fails.
    const extra = [
      "CREATE POLICY \"Public read access for branding\" ON storage.objects FOR SELECT USING (bucket_id = 'branding');",
      "CREATE POLICY \"Owners can upload branding\" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'branding');",
      "CREATE POLICY \"Owners can upload branding\" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK ((bucket_id = 'branding') AND private.is_owner());",
      "CREATE POLICY \"Owners can update branding\" ON storage.objects FOR UPDATE TO authenticated USING (true);",
      "UPDATE storage.buckets SET public = false WHERE id = 'branding';",
      "UPDATE storage.buckets SET file_size_limit = NULL WHERE id = 'branding';",
    ]
    for (const sql of extra) {
      const r = clean(`${ROLLBACK}\n${sql}`)
      expect(r.reopeners.length + r.rows.length, sql).toBeGreaterThan(0)
    }
  })
})
