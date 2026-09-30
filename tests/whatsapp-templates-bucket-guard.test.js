// WATPLBUCKET.1 guard (mig 670). The public 'whatsapp-templates' storage
// bucket is written only by the service role and by server-minted
// signed-upload tokens; no client policy admits it; and its size/MIME limits
// match src/lib/template-media.js. Pinned here:
//
//  1. Browser and phone code calls nothing on
//     `.storage.from('whatsapp-templates')` but uploadToSignedUrl (the token
//     from /api/whatsapp/templates/upload-media/sign authorises it; the
//     Storage API runs it as superuser) and getPublicUrl. upload, update,
//     remove, move, copy, list, createSignedUploadUrl, download… from a
//     session are refused after 670 (or, for reads, list object names that
//     keep the public URLs unguessable). Client-bound code = shared/,
//     mobile/, and every src/ file that is 'use client' (after any header
//     comment), names createBrowserClient, calls createAuthClient() or holds
//     the anon key.
//  2. After replaying every migration (scripts/check-rls-restrictive.mjs
//     netPolicyState), no PERMISSIVE storage.objects policy of any command
//     that reaches anon, authenticated or PUBLIC admits the bucket: it names
//     the bucket, or it has no positive `bucket_id = '<literal>'` restriction.
//  3. Every migration from SCAN_FROM on (a lower number can merge later) is
//     checked on its own for the same thing, including a CREATE POLICY run
//     from EXECUTE '…', and for an ALTER POLICY on storage.objects that names
//     the bucket.
//  The one exemption from 2-4 is a rollback migration named
//  `<NNN>_watplbucket1_rollback.sql` (it restores the 30 Sep state on purpose).
//  4. The LATEST migration that writes the bucket row sets file_size_limit
//     to the largest TEMPLATE_MEDIA_LIMITS maxBytes and allowed_mime_types
//     to the union of its mimes, and never makes it private. Change the JS
//     limits and the bucket together, in one PR, or signed uploads of the
//     new type are refused by Storage.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex), SQL comments by one quote- and dollar-aware pass (sqlCode, both
// copied from tests/whatsapp-templates-client-writes-guard.test.js). A floor,
// not a proof: a bucket name held in a variable, SQL built at runtime or a
// policy created by hand on prod is invisible; mig 670's self-check covers
// the live catalog at apply time. Server code is not checked: the service
// role bypasses RLS. champ-app never names the bucket (C90 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'
import { TEMPLATE_MEDIA_LIMITS } from '../src/lib/template-media.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUCKET_MIGRATION = 670
// Scanned from 631, not 670: migration numbers are reserved ahead of time and
// a lower number can merge later (631 is the HELD #1774, 663 #1849 when 670
// was written). 631-669 hold nothing the detector flags (checked).
const SCAN_FROM = 631
const BUCKET = 'whatsapp-templates'
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_watplbucket1_rollback\.sql$/
const CLIENT_OK = new Set(['uploadToSignedUrl', 'getPublicUrl'])
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
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

const STORAGE_CALL = /\.\s*storage\s*\??\.\s*from\(\s*['"`]whatsapp-templates['"`]\s*\)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g

/** Every method called on the bucket in already-stripped code. */
const bucketCallsIn = (code) => [...code.matchAll(STORAGE_CALL)].map((m) => m[1])
/** Every bucket call a client may not make, in `text` (comments excluded). */
export const forbiddenBucketCalls = (text, file) =>
  bucketCallsIn(stripComments(text, file)).filter((m) => !CLIENT_OK.has(m))

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
 * (Same rule as mig 670's self-check 3; `bucket_id = 'x' OR true` fools both.)
 */
export function admitsBucket({ permissive, roles, expr }) {
  if (permissive !== 'PERMISSIVE') return false
  if (!roles.some((r) => CLIENT_ROLES.includes(r))) return false
  return expr.includes(BUCKET) || !BUCKET_LITERAL.test(expr)
}

const OBJECTS = String.raw`(?:"?storage"?\s*\.\s*)"?objects"?`
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

/** Top-level statements that write the bucket row (DO/function bodies and comments removed). */
export function bucketRowWrites(sql) {
  const code = sqlCode(sql).replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, ' ')
  return code.split(';').map((s) => s.trim())
    .filter((s) => /^(update\s+"?storage"?\s*\.\s*"?buckets"?|insert\s+into\s+"?storage"?\s*\.\s*"?buckets"?)\b/i.test(s) && s.includes(`'${BUCKET}'`))
}

/** The limits a bucket-row write sets: { sizeLimit, mimes, makesPrivate }. */
export function bucketLimits(stmt) {
  const size = stmt.match(/\bfile_size_limit\s*=\s*(\d+)/i)
  const mimes = stmt.match(/\ballowed_mime_types\s*=\s*array\s*\[([^\]]*)\]/i)
  return {
    sizeLimit: size ? Number(size[1]) : null,
    mimes: mimes ? [...mimes[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null,
    makesPrivate: /\bpublic\s*=\s*false\b/i.test(stmt) || /\bvalues\s*\(\s*'whatsapp-templates'\s*,\s*'[^']*'\s*,\s*false\b/i.test(stmt),
  }
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

describe('client code never writes the whatsapp-templates bucket (WATPLBUCKET.1, mig 670)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police, and sees their signed uploads (not vacuous)', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'src/components/WATemplateEditor.jsx',
      'src/components/settings/integrations/WhatsAppIntegrationTab.jsx',
    ]))
    expect(names).not.toContain('src/app/api/whatsapp/templates/upload-media/route.js')
    expect(names).not.toContain('src/app/api/whatsapp/templates/upload-media/sign/route.js')
    const seen = clientFiles().flatMap((f) => bucketCallsIn(codeOfFile(f)).map((m) => `${rel(f)}: ${m}`))
    expect(seen).toEqual([
      'src/components/WATemplateEditor.jsx: uploadToSignedUrl',
      'src/components/settings/integrations/WhatsAppIntegrationTab.jsx: uploadToSignedUrl',
    ])
  })

  it('no browser or phone file calls anything on the bucket but uploadToSignedUrl / getPublicUrl', () => {
    const offenders = []
    for (const f of clientFiles()) {
      for (const m of bucketCallsIn(codeOfFile(f))) if (!CLIENT_OK.has(m)) offenders.push(`${rel(f)}: ${m}`)
    }
    expect(offenders, 'mint a signed upload in /api/whatsapp/templates/upload-media/sign; remove through a service-role route (mig 670 refuses client writes)').toEqual([])
  })

  it('the detector catches every client write shape and ignores the allowed ones and comments', () => {
    const bad = `
      await supabase.storage.from('whatsapp-templates').upload(p, file)
      await supabase.storage.from("whatsapp-templates")
        .remove([p])
      await supabase.storage?.from(\`whatsapp-templates\`)?.update(p, file)
      await supabase . storage . from('whatsapp-templates') . move(a, b)
      await supabase.storage.from('whatsapp-templates').list('')
      await supabase.storage.from('whatsapp-templates').createSignedUploadUrl(p)`
    expect(forbiddenBucketCalls(bad)).toEqual(['upload', 'remove', 'update', 'move', 'list', 'createSignedUploadUrl'])
    const ok = `
      await supabase.storage.from('whatsapp-templates').uploadToSignedUrl(p, t, file, { contentType })
      const { data } = supabase.storage.from('whatsapp-templates').getPublicUrl(p)
      // await supabase.storage.from('whatsapp-templates').remove([p])
      /* await supabase.storage.from('whatsapp-templates').upload(p, f) */
      await supabase.storage.from('whatsapp-media').upload(p, f)
      await supabase.from('whatsapp_templates').select('id')`
    expect(forbiddenBucketCalls(ok)).toEqual([])
  })

  it("a '/*' in a string or JSX text hides nothing", () => {
    expect(forbiddenBucketCalls("const a = 'image/*'\nsupabase.storage.from('whatsapp-templates').upload(p, f)\nconst b = '*/'\n"))
      .toEqual(['upload'])
    expect(forbiddenBucketCalls("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.storage.from('whatsapp-templates').remove([p])}<p>end */</p></div>\n}\n"))
      .toEqual(['remove'])
  })
})

describe('migrations keep the bucket closed to clients and its limits in step (mig 670)', () => {
  it('mig 670 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${BUCKET_MIGRATION}_`))).toBe(true)
  })

  it('after every migration, no client policy on storage.objects admits the bucket', () => {
    const net = netPolicyState(MIGRATIONS)
      .filter((p) => p.table === 'storage.objects' && !ROLLBACK_FILE.test(p.file))
    expect(net.length).toBeGreaterThan(3)   // not vacuous: branding, tv-content, contracts, the 403 deny
    const admitting = net
      .filter((p) => admitsBucket({ permissive: p.permissive, roles: p.roles, expr: `${p.using ?? ''} ${p.check ?? ''}` }))
      .map((p) => `${p.name} (${p.file})`)
    expect(admitting, 'a client policy admits the whatsapp-templates bucket (mig 670)').toEqual([])
    const names = net.map((p) => p.name)
    expect(names).not.toContain('wa_templates_storage_insert')
    expect(names).not.toContain('wa_templates_storage_delete')
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM && !ROLLBACK_FILE.test(f))
  it.each(later)('%s: no client policy that admits the bucket', (file) => {
    expect(bucketReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file} lets a client session write or list the whatsapp-templates bucket (mig 670). Upload through a signed-upload token instead`).toEqual([])
  })

  it('the latest write to the bucket row keeps it public and matches TEMPLATE_MEDIA_LIMITS', () => {
    const writes = migrationFiles().filter((f) => !ROLLBACK_FILE.test(f)).flatMap((f) => bucketRowWrites(readFileSync(path.join(MIGRATIONS, f), 'utf8')).map((s) => ({ f, s })))
    expect(writes.length).toBeGreaterThan(1)   // mig 045's INSERT, mig 670's UPDATE
    const last = writes.at(-1)
    const limits = bucketLimits(last.s)
    const all = Object.values(TEMPLATE_MEDIA_LIMITS)
    expect(limits, `${last.f} must set the bucket's limits from src/lib/template-media.js`).toEqual({
      sizeLimit: Math.max(...all.map((l) => l.maxBytes)),
      mimes: [...new Set(all.flatMap((l) => l.mimes))].sort(),
      makesPrivate: false,
    })
    for (const { f, s } of writes.filter((w) => parseInt(w.f, 10) >= BUCKET_MIGRATION)) {
      expect(bucketLimits(s).makesPrivate, `${f} makes the bucket private (Meta fetches header media by URL)`).toBe(false)
    }
  })

  it('the policy detector catches every form', () => {
    const bad = [
      "CREATE POLICY wa_templates_storage_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');",
      "create policy x on storage.objects for delete to anon, authenticated using (bucket_id = 'whatsapp-templates'::text);",
      "CREATE POLICY \"List templates\" ON \"storage\".\"objects\" FOR SELECT TO authenticated USING (bucket_id = 'whatsapp-templates');",
      'CREATE POLICY anyone ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);',
      'CREATE POLICY anyone ON storage.objects WITH CHECK (true);',
      "CREATE POLICY neg ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id <> 'branding');",
      "CREATE POLICY own ON storage.objects FOR UPDATE TO authenticated USING (owner = auth.uid());",
      `DO $$ BEGIN EXECUTE 'CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ''whatsapp-templates'')'; END $$;`,
      "ALTER POLICY tv_content_storage_write ON storage.objects WITH CHECK (bucket_id IN ('tv-content', 'whatsapp-templates'));",
      "SELECT '/*';\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');\nSELECT '*/';",
      "-- a note with /* in it\nCREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);\n-- */",
    ]
    for (const sql of bad) expect(bucketReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      "CREATE POLICY \"Owners can upload branding\" ON storage.objects FOR INSERT TO authenticated WITH CHECK ((bucket_id = 'branding'::text) AND private.is_owner());",
      "CREATE POLICY tv ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tv-content');",
      "CREATE POLICY \"private buckets deny client\" ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id NOT IN ('whatsapp-media'));",
      "CREATE POLICY svc ON storage.objects FOR ALL TO service_role USING (true);",
      'DROP POLICY IF EXISTS wa_templates_storage_insert ON storage.objects;',
      "CREATE POLICY x ON public.whatsapp_templates FOR SELECT TO authenticated USING (true);",
      "-- CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-templates');",
      "/* CREATE POLICY p ON storage.objects FOR INSERT TO authenticated WITH CHECK (true); */",
      "ALTER POLICY tv_content_storage_write ON storage.objects TO authenticated;",
    ]
    for (const sql of ok) expect(bucketReopeners(sql), sql).toEqual([])
  })

  it('reads the bucket row writes and their limits', () => {
    const sql = `UPDATE storage.buckets SET public = true, file_size_limit = 104857600,
      allowed_mime_types = ARRAY['video/mp4', 'image/png'] WHERE id = 'whatsapp-templates';
      DO $$ BEGIN PERFORM 1 FROM storage.buckets WHERE id = 'whatsapp-templates'; END $$;
      UPDATE storage.buckets SET file_size_limit = 1 WHERE id = 'branding';`
    const writes = bucketRowWrites(sql)
    expect(writes).toHaveLength(1)
    expect(bucketLimits(writes[0])).toEqual({ sizeLimit: 104857600, mimes: ['image/png', 'video/mp4'], makesPrivate: false })
    expect(bucketLimits("UPDATE storage.buckets SET public = false WHERE id = 'whatsapp-templates'").makesPrivate).toBe(true)
    expect(bucketLimits("INSERT INTO storage.buckets (id, name, public) VALUES ('whatsapp-templates', 'whatsapp-templates', false)").makesPrivate).toBe(true)
  })

  it('a rollback migration is exempt only under its exact name', () => {
    expect(ROLLBACK_FILE.test('671_watplbucket1_rollback.sql')).toBe(true)
    expect(ROLLBACK_FILE.test('671_whatsapp_templates_bucket_reopen.sql')).toBe(false)
  })
})
