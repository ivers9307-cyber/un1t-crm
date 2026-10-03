// TVBUCKET.1 guard (mig 671). The public 'tv-content' storage bucket is
// written only by the service role (POST /api/admin/tv-displays/upload) and by
// a signed upload against a slot a service-role route minted (…/upload/sign,
// TVUPLOAD.1); no client policy admits it; and its size/MIME limits match src/lib/tv-media.js,
// the list the upload route validates against. Pinned here:
//
//  1. Browser and phone code calls nothing on `.storage.from('tv-content')`
//     but getPublicUrl (the phone's tvImageUrl) and uploadToSignedUrl (the
//     phone's uploadTvImage since TVUPLOAD.1: a token minted by the
//     service-role /api/admin/tv-displays/upload/sign authorises it, and the
//     Storage API runs it as superuser within the bucket's limits). upload, update, remove, move, copy, list, createSignedUploadUrl,
//     download… from a session are refused after 671 (or, for reads, list
//     object names that keep the public URLs unguessable). Every mention of
//     the bucket name in client code sits inside one of those two calls, a
//     PUBLIC read path (`/storage/v1/object/public/tv-content/…`, what
//     TemplateEditor.jsx builds) or a token-authorised signed-upload path
//     (`/storage/v1/object/upload/sign/tv-content/…`), so a handle in a
//     variable, a destructured `storage`, bracket access, a TS generic
//     (`.upload<T>(`) or a raw Storage REST write path cannot hide a write;
//     a constant holding the name (defined anywhere in the app) never
//     reaches `.from(…)` in client code. Client-bound code = shared/, mobile/, desktop/src, and every src/
//     file that is 'use client' (after any header comment), names
//     createBrowserClient, calls createAuthClient() or holds the anon key.
//  2. After replaying every migration (scripts/check-rls-restrictive.mjs
//     netPolicyState), no PERMISSIVE storage.objects policy of any command
//     that reaches anon, authenticated or PUBLIC admits the bucket: it names
//     the bucket, or it has no positive `bucket_id = '<literal>'` restriction.
//  3. Every migration from SCAN_FROM on (a lower number can merge later) is
//     checked on its own for the same thing, including a CREATE POLICY run
//     from EXECUTE '…', and for an ALTER POLICY on storage.objects that names
//     the bucket.
//  The one exemption from 2-4 is a rollback migration named
//  `<NNN>_tvbucket1_rollback.sql`, and only for the statements that restore
//  the 30 Sep state (mig 160's two policies with their exact text, both
//  limits back to NULL); anything else in that file is checked.
//  4. The LATEST migration that writes the bucket row sets file_size_limit
//     to TV_IMAGE_MAX_BYTES and allowed_mime_types to TV_IMAGE_MIME_TYPES.
//     And every migration from SCAN_FROM on, on its own, never makes the
//     bucket private (an UPDATE with no WHERE and an INSERT that omits
//     `public` count) and sets no limit that differs from those: a
//     lower-numbered file merged after 671 runs on prod after it but sorts
//     before it, so "the latest" alone cannot see it. A limit written as
//     anything but a literal (or NULL) is unreadable and fails. The upload
//     route validates with the same two constants (checked here too). Change
//     the JS limits and the bucket together, in one PR, or the route accepts
//     a file Storage then refuses.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; no range taken where JSX text starts), SQL comments by one
// quote- and dollar-aware pass that pairs each $tag$ with its own closing
// tag (sqlCode). All helpers are copied verbatim from
// tests/whatsapp-templates-bucket-guard.test.js (importing a test file would
// re-register its tests here; follow-ups C74 moves them to tests/helpers/).
// A floor, not a proof: a bucket name built at runtime (`tv-${x}`, a join, an
// object property defined outside client code), SQL built at runtime or a
// policy created by hand on prod is invisible; mig 671's self-check covers
// the live catalog at apply time. Server code is not checked: the service
// role bypasses RLS. champ-app, champ-bridge and un1t-pi never name the
// bucket (C92 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'
import { TV_IMAGE_MIME_TYPES, TV_IMAGE_MAX_BYTES } from '../src/lib/tv-media.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUCKET_MIGRATION = 671
// Scanned from 631, not 671: migration numbers are reserved ahead of time and
// a lower number can merge later (631 is the HELD #1774, 663 #1849 when 671
// was written). 631-670 hold nothing the detector flags (checked).
const SCAN_FROM = 631
const BUCKET = 'tv-content'
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_tvbucket1_rollback\.sql$/
const CLIENT_OK = new Set(['uploadToSignedUrl', 'getPublicUrl'])
const UPLOAD_ROUTE = 'src/app/api/admin/tv-displays/upload/route.js'
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

/**
 * JS/TS with comments blanked (newlines and offsets kept), from the
 * TypeScript parser's own comment ranges, so a '/*' or '//' inside a string,
 * template or regex literal is never read as a comment. JSX text is not
 * trivia, but asked for comments at its start the scanner reads
 * `<p>/* note</p>` as one, so no range is taken at a position where JSX text
 * begins (tests/staff-profile-to-client.test.js). A file the parser cannot
 * read is returned raw: a false positive beats a blind spot.
 */
export function stripComments(text, file = 'scan.jsx') {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  if (sf.parseDiagnostics?.length) return text
  const jsxTextAt = new Set()
  const findJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxTextAt.add(node.pos)
    for (const child of node.getChildren(sf)) findJsxText(child)
  }
  findJsxText(sf)
  const ranges = new Map()
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.set(r.pos, r.end)
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, end] of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end)
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code.trimStart()) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
export const isClientFile = (text, file) => isClientCode(stripComments(text, file))

// Every file is parsed once per run (the TypeScript parse is the slow part).
const CODE = new Map()
const codeOfFile = (f) => {
  if (!CODE.has(f)) CODE.set(f, stripComments(readFileSync(f, 'utf8'), f))
  return CODE.get(f)
}
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

const STORAGE_CALL = /\.\s*storage\s*\??\.\s*from\(\s*['"`]tv-content['"`]\s*\)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g

/** Every method called on the bucket in already-stripped code. */
const bucketCallsIn = (code) => [...code.matchAll(STORAGE_CALL)].map((m) => m[1])
/** Every bucket call a client may not make, in `text` (comments excluded). */
export const forbiddenBucketCalls = (text, file) =>
  bucketCallsIn(stripComments(text, file)).filter((m) => !CLIENT_OK.has(m))

// The call detector above only sees `.storage.from('<bucket>').<method>(`.
// A bucket handle kept in a variable, a destructured `storage`, bracket
// access, a TypeScript generic (`.upload<T>(`), a constant, or a raw
// Storage REST write path are invisible to it. So every mention of the
// bucket name in client code must sit inside an allowed call, a PUBLIC read
// path or a signed-upload path (the token authorises it), and a constant that holds the name (defined anywhere in src/,
// shared/, mobile/, desktop/src) must never reach `.from(…)` in client code.
const BUCKET_TOKEN = /(?<![\w-])tv-content(?![\w-])/g
const ALLOWED_USE = /\.\s*from\(\s*(['"`])tv-content\1\s*\)\s*\??\.\s*(?:uploadToSignedUrl|getPublicUrl)\s*\(|\/storage\/v1\/(?:object\/(?:public|upload\/sign)|render\/image\/public)\/tv-content\//g
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names of variables initialised to the bucket name, in already-stripped code. */
export function bucketConstantsIn(code) {
  return [...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])tv-content\2/g)].map((m) => m[1])
}

let BUCKET_CONSTS = null
function bucketConstants() {
  if (BUCKET_CONSTS) return BUCKET_CONSTS
  const all = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...desktopFiles()]
  BUCKET_CONSTS = [...new Set(all.flatMap((f) => bucketConstantsIn(codeOfFile(f))))]
  return BUCKET_CONSTS
}

/** Every mention of the bucket in already-stripped client code that is not an allowed call, public read path or signed-upload path. */
export function strayBucketUses(code, consts = []) {
  const allowed = [...code.matchAll(ALLOWED_USE)].map((m) => [m.index, m.index + m[0].length])
  const line = (i) => code.slice(0, i).split('\n').length
  const out = []
  for (const m of code.matchAll(BUCKET_TOKEN)) {
    if (!allowed.some(([a, b]) => m.index >= a && m.index < b)) out.push(`line ${line(m.index)}: the bucket name outside getPublicUrl/uploadToSignedUrl/a public or signed-upload path`)
  }
  for (const name of new Set(consts)) {
    const re = new RegExp(String.raw`\.\s*from\(\s*(?:[\w$]+\s*\??\.\s*)*${reEscape(name)}\s*\)`, 'g')
    for (const m of code.matchAll(re)) out.push(`line ${line(m.index)}: .from(${name}), a constant holding the bucket name`)
  }
  return out
}

// ── migrations ───────────────────────────────────────────────────────────
/**
 * The SQL with its comments blanked (newlines kept), by a quote-aware scan:
 * '…' (with '' doubling, and backslash escapes in E'…'), "…" identifiers and
 * $tag$…$tag$ bodies are never read as comment markers, so a '/*' or '--'
 * inside one cannot hide code. Block comments nest, as in Postgres. A
 * dollar-quoted body is matched to its own closing tag first and scanned the
 * same way on its own, so nothing inside can run past it. String contents
 * are kept verbatim: a GRANT run from EXECUTE '…' counts.
 * (tests/function-execute-guard.test.js sqlCode, copied verbatim rather than
 * imported: importing a test file would re-register its tests here.)
 */
export function sqlCode(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const DOLLAR = /\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      out += blank(sql.slice(i, j))
      i = j
      continue
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      DOLLAR.lastIndex = i
      const m = DOLLAR.exec(sql)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) { out += sql.slice(i); break }
        out += tag + sqlCode(sql.slice(i + tag.length, end)) + tag
        i = end + tag.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

const CLIENT_ROLES = ['anon', 'authenticated', 'public']
// A positive single-bucket restriction; '' covers a policy inside EXECUTE '…'.
const BUCKET_LITERAL = /\bbucket_id\s*=\s*'+[^']+'/i

/**
 * Does a PERMISSIVE policy reaching a client role admit the bucket? It does
 * when its expression names the bucket, or restricts no bucket at all.
 * (Same rule as mig 671's self-check 3; `bucket_id = 'x' OR true` fools both.)
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

const EXPECTED_SIZE = TV_IMAGE_MAX_BYTES
const EXPECTED_MIMES = [...TV_IMAGE_MIME_TYPES].sort()

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

/** Every way the bucket-row writes in `sql` break the bucket (private, or limits out of step with tv-media.js). */
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

// A rollback migration (`<NNN>_tvbucket1_rollback.sql`) may restore the
// 30 Sep state and nothing more: re-create mig 160's two policies with their
// exact text, and set both limits back to NULL. Only those statements are
// exempt; everything else in the file is checked like any other migration.
const ROLLBACK_POLICIES = new Set(['tv_content_storage_write', 'tv_content_storage_delete'])
const ROLLBACK_OK = [
  /^create policy "?tv_content_storage_write"? on "?storage"?\."?objects"? (?:as permissive )?for insert to "?authenticated"? with check \(bucket_id = 'tv-content'\)$/,
  /^create policy "?tv_content_storage_delete"? on "?storage"?\."?objects"? (?:as permissive )?for delete to "?authenticated"? using \(bucket_id = 'tv-content'\)$/,
  /^update "?storage"?\."?buckets"? set (?:file_size_limit = null, allowed_mime_types = null|allowed_mime_types = null, file_size_limit = null) where id = 'tv-content'$/,
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

describe('client code never writes the tv-content bucket (TVBUCKET.1, mig 671)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police, and sees their bucket reads (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'mobile/lib/tv-api.js',
      'src/app/(operations)/tv-displays/TVAdmin.jsx',
      'src/app/(operations)/tv-displays/TemplateEditor.jsx',
    ]))
    if (existsSync(DESKTOP)) expect(names).toContain('desktop/src/index.html')
    expect(names).not.toContain(UPLOAD_ROUTE)
    expect(names).not.toContain('src/app/api/public/tv/[token]/content/route.js')
    const seen = clientFiles().flatMap((f) => bucketCallsIn(codeOfFile(f)).map((m) => `${rel(f)}: ${m}`))
    // TVUPLOAD.1 (C93) — the phone uploads TV images with a signed-upload token.
    expect(seen).toEqual(['mobile/lib/tv-api.js: getPublicUrl', 'mobile/lib/tv-api.js: uploadToSignedUrl'])
    // TemplateEditor.jsx's bucketPublicUrl builds the public read path by hand.
    expect(codeOfFile(path.join(ROOT, 'src/app/(operations)/tv-displays/TemplateEditor.jsx')))
      .toMatch(/\/storage\/v1\/object\/public\/tv-content\//)
  })

  it('no browser or phone file calls anything on the bucket but getPublicUrl / uploadToSignedUrl', () => {
    const offenders = []
    for (const f of clientFiles()) {
      for (const m of bucketCallsIn(codeOfFile(f))) if (!CLIENT_OK.has(m)) offenders.push(`${rel(f)}: ${m}`)
    }
    expect(offenders, `upload through POST /${UPLOAD_ROUTE.replace(/^src\/app\/|\/route\.js$/g, '')} (service role); mig 671 refuses client writes`).toEqual([])
  })

  it('the detector catches every client write shape and ignores the allowed ones and comments', () => {
    const bad = `
      await supabase.storage.from('tv-content').upload(p, file)
      await supabase.storage.from("tv-content")
        .remove([p])
      await supabase.storage?.from(\`tv-content\`)?.update(p, file)
      await supabase . storage . from('tv-content') . move(a, b)
      await supabase.storage.from('tv-content').list('')
      await supabase.storage.from('tv-content').createSignedUploadUrl(p)`
    expect(forbiddenBucketCalls(bad)).toEqual(['upload', 'remove', 'update', 'move', 'list', 'createSignedUploadUrl'])
    const ok = `
      const url = supabase.storage.from('tv-content').getPublicUrl(path).data.publicUrl
      await supabase.storage.from('tv-content').uploadToSignedUrl(p, t, file, { contentType })
      // await supabase.storage.from('tv-content').remove([p])
      /* await supabase.storage.from('tv-content').upload(p, f) */
      await supabase.storage.from('branding').upload(p, f)
      await supabase.from('tv_content').upsert(row)`
    expect(forbiddenBucketCalls(ok)).toEqual([])
  })

  it('every mention of the bucket in browser or phone code is an allowed call or a public read path', () => {
    const consts = bucketConstants()
    const offenders = clientFiles().flatMap((f) => strayBucketUses(codeOfFile(f), consts).map((u) => `${rel(f)}: ${u}`))
    expect(offenders, "name the bucket only as .storage.from('tv-content').getPublicUrl(…) or a /storage/v1/object/public/tv-content/ URL in client code (mig 671)").toEqual([])
  })

  it('the stray-use detector catches the shapes the call detector cannot see', () => {
    const sneaky = [
      ["const b = supabase.storage.from('tv-content')\nawait b.remove([p])", 'x.js'],
      ["const { storage } = supabase\nawait storage.from('tv-content').remove([p])", 'x.js'],
      ["await supabase.storage.from('tv-content')['remove']([p])", 'x.js'],
      ["await supabase.storage.from('tv-content').upload<Blob>(p, f)", 'x.ts'],
      ["const TV_BUCKET = 'tv-content'\nawait supabase.storage.from(TV_BUCKET).remove([p])", 'x.js'],
      ["await fetch(`${url}/storage/v1/object/tv-content/${p}`, { method: 'POST', body: f })", 'x.js'],
      ["await fetch(`${url}/storage/v1/object/tv-content/${p}`, { method: 'PUT', headers: { 'x-upsert': 'true' }, body: f })", 'x.js'],
      ["await fetch(url + '/storage/v1/object/list/tv-content', { method: 'POST', body: '{}' })", 'x.js'],
      ["await supabase.storage.from('tv-content').getPublicUrl(p)\nawait supabase.storage.from('tv-content').move(a, b)", 'x.js'],
    ]
    for (const [text, file] of sneaky) {
      expect(strayBucketUses(stripComments(text, file)), text).not.toEqual([])
    }
    // A constant defined elsewhere (a server lib, a shared config) and used here.
    const imported = "import { TV_BUCKET } from '@/lib/tv'\nawait supabase.storage.from(TV_BUCKET).remove([p])\nawait supabase.storage.from(cfg.TV_BUCKET).list('')"
    expect(strayBucketUses(stripComments(imported, 'x.js'), ['TV_BUCKET'])).toHaveLength(2)
    expect(bucketConstantsIn("export const TV_BUCKET = 'tv-content'\nlet b2 = `tv-content`\nconst other = 'branding'"))
      .toEqual(['TV_BUCKET', 'b2'])
    const ok = [
      "return supabase.storage.from('tv-content').getPublicUrl(path).data.publicUrl",
      "const { data } = supabase.storage\n  .from('tv-content')\n  .getPublicUrl(p)",
      "await supabase.storage.from(\"tv-content\")?.uploadToSignedUrl(p, t, f)",
      'return `${SUPA_URL}/storage/v1/object/public/tv-content/${path}`',
      "const src = base + '/storage/v1/render/image/public/tv-content/' + p + '?width=640'",
      "await fetch(`${url}/storage/v1/object/upload/sign/tv-content/${p}?token=${t}`, { method: 'PUT', body: bytes })",
      "// await supabase.storage.from('tv-content').remove([p])",
      "await fetch('/api/admin/tv-displays/upload', { method: 'POST', body: fd })",
      "await supabase.from('tv_content').upsert(row)",
      "const key = `tv-content-${id}`",
      "await supabase.storage.from(OTHER_BUCKET).remove([p])",
    ]
    for (const text of ok) expect(strayBucketUses(stripComments(text, 'x.js'), ['TV_BUCKET']), text).toEqual([])
  })

  it("a '/*' in a string or JSX text hides nothing", () => {
    expect(forbiddenBucketCalls("const a = 'image/*'\nsupabase.storage.from('tv-content').upload(p, f)\nconst b = '*/'\n"))
      .toEqual(['upload'])
    expect(forbiddenBucketCalls("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.storage.from('tv-content').remove([p])}<p>end */</p></div>\n}\n"))
      .toEqual(['remove'])
  })
})

describe('the upload route validates with the bucket limits (TVBUCKET.1)', () => {
  it('imports TV_IMAGE_MIME_TYPES and TV_IMAGE_MAX_BYTES and keeps no list or cap of its own', () => {
    const code = codeOfFile(path.join(ROOT, UPLOAD_ROUTE))
    expect(code).toMatch(/import\s*\{[^}]*\bTV_IMAGE_MIME_TYPES\b[^}]*\}\s*from\s*['"]@\/lib\/tv-media['"]/)
    expect(code).toMatch(/import\s*\{[^}]*\bTV_IMAGE_MAX_BYTES\b[^}]*\}\s*from\s*['"]@\/lib\/tv-media['"]/)
    expect(code).toMatch(/TV_IMAGE_MIME_TYPES\.includes\(\s*file\.type\s*\)/)
    expect(code).toMatch(/file\.size\s*>\s*TV_IMAGE_MAX_BYTES/)
    expect(code, 'no inline MIME list: the route and the bucket share src/lib/tv-media.js').not.toMatch(/['"]image\/(?:png|jpeg|webp|gif|avif)['"]/)
    expect(code).toMatch(/\.from\(\s*['"]tv-content['"]\s*\)\s*\.upload\(/)
    expect(code).toMatch(/upsert:\s*false/)
  })
})

describe('migrations keep the bucket closed to clients and its limits in step (mig 671)', () => {
  it('mig 671 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${BUCKET_MIGRATION}_`))).toBe(true)
  })

  it('after every migration, no client policy on storage.objects admits the bucket', () => {
    const net = netPolicyState(MIGRATIONS)
      .filter((p) => p.table === 'storage.objects' && !(ROLLBACK_FILE.test(p.file) && ROLLBACK_POLICIES.has(p.name)))
    expect(net.length).toBeGreaterThan(3)   // not vacuous: the three contracts reads, the 403 deny
    const admitting = net
      .filter((p) => admitsBucket({ permissive: p.permissive, roles: p.roles, expr: `${p.using ?? ''} ${p.check ?? ''}` }))
      .map((p) => `${p.name} (${p.file})`)
    expect(admitting, 'a client policy admits the tv-content bucket (mig 671)').toEqual([])
    const names = net.map((p) => p.name)
    expect(names).not.toContain('tv_content_storage_write')
    expect(names).not.toContain('tv_content_storage_delete')
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client policy that admits the bucket', (file) => {
    expect(bucketReopeners(scanText(file)),
      `${file} lets a client session write or list the tv-content bucket (mig 671). Upload through the service-role route instead`).toEqual([])
  })

  it('the latest write to the bucket row keeps it public and matches src/lib/tv-media.js', () => {
    const writes = migrationFiles().flatMap((f) => bucketRowWrites(scanText(f)).map((s) => ({ f, s })))
    expect(writes.length).toBeGreaterThan(1)   // mig 160's INSERT, mig 671's UPDATE
    const last = writes.at(-1)
    expect(bucketLimits(last.s), `${last.f} must set the bucket's limits from src/lib/tv-media.js`).toEqual({
      sizeLimit: EXPECTED_SIZE,
      mimes: EXPECTED_MIMES,
      makesPrivate: false,
    })
  })

  it.each(later)('%s: never makes the bucket private, and any limit it sets matches tv-media.js', (file) => {
    // Per file, not only the latest write: a lower-numbered file that merges
    // after 671 runs on prod AFTER it, yet sorts before it here.
    expect(bucketRowProblems(scanText(file)),
      `${file} breaks the tv-content bucket: keep it public (TVs and the phone load images by URL) and set its limits from src/lib/tv-media.js`).toEqual([])
  })

  it('the bucket-row check catches every form', () => {
    const bad = [
      "UPDATE storage.buckets SET public = false WHERE id = 'tv-content';",
      "UPDATE \"storage\".\"buckets\" SET \"public\" = false WHERE id = 'tv-content';",
      'UPDATE storage.buckets SET public = false;',
      "UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET file_size_limit = 52428800 WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET file_size_limit = 15 * 1024 * 1024 WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/png'] WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET allowed_mime_types = '{image/png}' WHERE id = 'tv-content';",
      "INSERT INTO storage.buckets (id, name) VALUES ('tv-content', 'tv-content') ON CONFLICT (id) DO NOTHING;",
      "INSERT INTO storage.buckets (id, public, name) VALUES ('tv-content', false, 'tv-content');",
      "INSERT INTO storage.buckets (id, name, public) VALUES ('tv-content', 'tv-content', true) ON CONFLICT (id) DO UPDATE SET file_size_limit = NULL;",
    ]
    for (const sql of bad) expect(bucketRowProblems(sql), sql).not.toEqual([])
    const mimeArray = `ARRAY[${EXPECTED_MIMES.map((m) => `'${m}'`).join(', ')}]`
    const ok = [
      `UPDATE storage.buckets SET public = true, file_size_limit = ${EXPECTED_SIZE}, allowed_mime_types = ${mimeArray} WHERE id = 'tv-content';`,
      `UPDATE storage.buckets SET allowed_mime_types = ${mimeArray}::text[] WHERE id = 'tv-content';`,
      `UPDATE storage.buckets SET allowed_mime_types = '{${[...EXPECTED_MIMES].reverse().join(',')}}' WHERE id = 'tv-content';`,
      "UPDATE storage.buckets SET public = true WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'branding';",
      "INSERT INTO storage.buckets (id, name, public) VALUES ('tv-content', 'tv-content', TRUE) ON CONFLICT (id) DO NOTHING;",
      "-- UPDATE storage.buckets SET public = false WHERE id = 'tv-content';",
    ]
    for (const sql of ok) expect(bucketRowProblems(sql), sql).toEqual([])
  })

  it('the policy detector catches every form', () => {
    const bad = [
      "CREATE POLICY tv_content_storage_write ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');",
      "create policy x on storage.objects for delete to anon, authenticated using (bucket_id = 'tv-content'::text);",
      "CREATE POLICY \"List TV content\" ON \"storage\".\"objects\" FOR SELECT TO authenticated USING (bucket_id = 'tv-content');",
      'CREATE POLICY anyone ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY anyone ON storage.objects WITH CHECK (true);',
      "CREATE POLICY neg ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id <> 'branding');",
      "CREATE POLICY own ON storage.objects FOR UPDATE TO authenticated USING (owner = auth.uid());",
      `DO $$ BEGIN EXECUTE 'CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ''tv-content'')'; END $$;`,
      "ALTER POLICY \"Owners can upload branding\" ON storage.objects WITH CHECK (bucket_id IN ('branding', 'tv-content'));",
      "SELECT '/*';\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');\nSELECT '*/';",
      "-- a note with /* in it\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);\n-- */",
      // Unqualified: storage.objects under a search_path that includes storage.
      "SET search_path = storage, public;\nCREATE POLICY p ON objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');",
      "ALTER POLICY \"Owners can upload branding\" ON \"objects\" WITH CHECK (bucket_id IN ('branding', 'tv-content'));",
      // A $$ body closed before a later literal: the pairing must not flip.
      "DO $$ BEGIN PERFORM 1; END $$;\nSELECT $$ /* $$;\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');\nSELECT $$ */ $$;",
    ]
    for (const sql of bad) expect(bucketReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      "CREATE POLICY \"Owners can upload branding\" ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());",
      "CREATE POLICY wa ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');",
      "CREATE POLICY \"private buckets deny client\" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id NOT IN ('tv-content'));",
      "CREATE POLICY svc ON storage.objects FOR ALL TO service_role USING (true);",
      'DROP POLICY IF EXISTS tv_content_storage_write ON storage.objects;',
      "CREATE POLICY x ON public.tv_content FOR SELECT TO authenticated USING (true);",
      "-- CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');",
      "/* CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true); */",
      "ALTER POLICY \"Owners can upload branding\" ON storage.objects TO authenticated;",
      'CREATE POLICY x ON public.objects FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY x ON objects_log FOR INSERT TO authenticated WITH CHECK (true);',
    ]
    for (const sql of ok) expect(bucketReopeners(sql), sql).toEqual([])
  })

  it('reads the bucket row writes and their limits', () => {
    const sql = `UPDATE storage.buckets SET public = true, file_size_limit = 15728640,
      allowed_mime_types = ARRAY['image/png', 'image/jpeg'] WHERE id = 'tv-content';
      DO $$ BEGIN PERFORM 1 FROM storage.buckets WHERE id = 'tv-content'; END $$;
      UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'branding';`
    const writes = bucketRowWrites(sql)
    expect(writes).toHaveLength(1)
    expect(bucketLimits(writes[0])).toEqual({ sizeLimit: 15728640, mimes: ['image/jpeg', 'image/png'], makesPrivate: false })
    expect(bucketLimits("UPDATE storage.buckets SET public = false WHERE id = 'tv-content'").makesPrivate).toBe(true)
    expect(bucketLimits("INSERT INTO storage.buckets (id, name, public) VALUES ('tv-content', 'tv-content', false)").makesPrivate).toBe(true)
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('672_tvbucket1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('672_tv_content_bucket_reopen.sql')).toBe(false)
    expect(ROLLBACK_FILE.test('672_watplbucket1_rollback.sql')).toBe(false)
  })

  it('…and only for the three statements that restore the 30 Sep state; anything else in it is still checked', () => {
    // The C92 plan's rollback record (Task 6 Step 7), verbatim.
    const ROLLBACK = `BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE POLICY tv_content_storage_write ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');
CREATE POLICY tv_content_storage_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'tv-content');
UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL
 WHERE id = 'tv-content';
COMMIT;`
    const clean = (sql) => ({ reopeners: bucketReopeners(rollbackRemainder(sql)), rows: bucketRowProblems(rollbackRemainder(sql)) })
    expect(clean(ROLLBACK)).toEqual({ reopeners: [], rows: [] })
    // The partial rollback (limits only), and the same statements spelt differently.
    expect(clean("UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id = 'tv-content';")).toEqual({ reopeners: [], rows: [] })
    expect(clean(`create policy "tv_content_storage_write" on "storage"."objects" for insert to authenticated
      with check ( bucket_id='tv-content'::text );
      UPDATE storage.buckets SET allowed_mime_types = NULL,file_size_limit = NULL WHERE id = 'tv-content';`)).toEqual({ reopeners: [], rows: [] })
    // Anything beyond those three still fails.
    const extra = [
      "CREATE POLICY tv_content_list ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'tv-content');",
      "CREATE POLICY tv_content_storage_write ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);",
      "CREATE POLICY tv_content_storage_write ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'tv-content');",
      "CREATE POLICY tv_content_storage_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'tv-content');",
      "UPDATE storage.buckets SET public = false WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL, public = false WHERE id = 'tv-content';",
      "UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'tv-content';",
    ]
    for (const sql of extra) {
      const r = clean(`${ROLLBACK}\n${sql}`)
      expect(r.reopeners.length + r.rows.length, sql).toBeGreaterThan(0)
    }
  })
})
