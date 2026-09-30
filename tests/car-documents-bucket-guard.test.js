// CARDOCBUCKET.1 guard (mig 687). The private 'car-documents' bucket's
// limits, the upload route's checks, the web picker and every server writer
// agree on ONE list, src/lib/car-document-media.js. Pinned here:
//
//  1. The LATEST migration that writes the bucket row sets file_size_limit to
//     CAR_DOCUMENT_MAX_BYTES and allowed_mime_types to CAR_DOCUMENT_MIME_TYPES
//     (literals; anything else is unreadable and fails), and no migration
//     from 687 on makes the bucket public.
//  2. The upload route validates with the shared constants and
//     resolveCarDocumentType, and keeps no size literal of its own.
//  3. Every non-test src/ file that uploads into the bucket is a known
//     writer, and each literal contentType it sends is on the list. A new
//     writer must be added to WRITERS with its type.
//  4. DocumentsCard's picker offers CAR_DOCUMENT_ACCEPT, not a literal list.
//  5. CARDOCUPLOAD.1 (C124): the signed-upload path — the only file that
//     mints a signed upload into the bucket is …/documents/sign, the only
//     one that uploads against one is the browser flow, and sign, finalise
//     and the flow judge size and type with the shared helpers (no size
//     literal of their own). A new signed writer must be added to
//     SIGNED_WRITERS.
//
// Comments are blanked first (tests/helpers/js-code.js stripComments, the
// TypeScript parser's ranges; tests/helpers/sql-code.js sqlCode, $tag$-paired).
// A floor, not a proof: a bucket name built at runtime, a contentType held
// in a variable other than the route's resolved one, or a bucket changed by
// hand on prod is invisible; mig 687's self-check covers the live catalog
// at apply time. Client access is not checked here: mig 403's restrictive
// deny closes the bucket and mig 687's self-check pins that policy.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'
import { sqlCode } from './helpers/sql-code.js'
import {
  CAR_DOCUMENT_MIME_TYPES, CAR_DOCUMENT_MAX_BYTES,
} from '../src/lib/car-document-media.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUCKET_MIGRATION = 687
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const UPLOAD_ROUTE = 'src/app/api/cars/[id]/documents/route.js'
const PICKER = 'src/components/cars/DocumentsCard.jsx'
const SIGN_ROUTE = 'src/app/api/cars/[id]/documents/sign/route.js'
const FINALISE_ROUTE = 'src/app/api/cars/[id]/documents/finalise/route.js'
const UPLOAD_CLIENT = 'src/lib/car-document-upload-client.js'
const UPLOAD_RULES = 'src/lib/car-document-upload.js'
// file → the signed-upload call it makes on the bucket.
const SIGNED_WRITERS = {
  [SIGN_ROUTE]: 'createSignedUploadUrl',
  [UPLOAD_CLIENT]: 'uploadToSignedUrl',
}
// file → how it sends its type. 'resolved' = the route's contentType variable.
const WRITERS = {
  [UPLOAD_ROUTE]: 'resolved',
  'src/lib/xero/invoices.js': 'literal',
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

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

/** Each statement that writes the car-documents row of storage.buckets: { file, n, sql }. */
function bucketWrites() {
  const out = []
  for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const n = Number(f.split('_')[0])
    for (const stmt of sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8')).split(';')) {
      if (/\b(update|insert\s+into)\s+storage\.buckets\b/i.test(stmt) && /'car-documents'/.test(stmt)) {
        out.push({ file: f, n, sql: stmt })
      }
    }
  }
  return out
}
function literalLimit(sql) {
  const m = sql.match(/file_size_limit\s*=\s*(\d+|null)\b/i)
  return m ? (m[1].toLowerCase() === 'null' ? null : Number(m[1])) : undefined
}
function literalMimes(sql) {
  const m = sql.match(/allowed_mime_types\s*=\s*(null|array\s*\[([^\]]*)\])/i)
  if (!m) return undefined
  if (m[1].toLowerCase() === 'null') return null
  return [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('car-documents bucket guard (CARDOCBUCKET.1, mig 687)', { timeout: 120_000 }, () => {
  it('1. the latest migration writing the bucket sets exactly the shared limits', () => {
    const writes = bucketWrites()
    const latest = writes.filter((w) => /\bupdate\b/i.test(w.sql)).at(-1)
    expect(latest?.n, 'no UPDATE of the car-documents bucket row found').toBeGreaterThanOrEqual(BUCKET_MIGRATION)
    expect(literalLimit(latest.sql), latest.file).toBe(CAR_DOCUMENT_MAX_BYTES)
    expect([...(literalMimes(latest.sql) || [])].sort(), latest.file).toEqual([...CAR_DOCUMENT_MIME_TYPES].sort())
    for (const w of writes.filter((x) => x.n >= BUCKET_MIGRATION)) {
      expect(/\bpublic\s*=\s*true\b/i.test(w.sql), `${w.file} makes car-documents public`).toBe(false)
      const lim = literalLimit(w.sql)
      if (lim !== undefined) expect(lim, w.file).toBe(CAR_DOCUMENT_MAX_BYTES)
      const mimes = literalMimes(w.sql)
      if (mimes !== undefined) expect([...(mimes || [])].sort(), w.file).toEqual([...CAR_DOCUMENT_MIME_TYPES].sort())
    }
  })

  it('2. the upload route validates with the shared constants and keeps no size literal', () => {
    const code = stripComments(read(UPLOAD_ROUTE))
    expect(code).toMatch(/from\s+'@\/lib\/car-document-media'/)
    expect(code).toMatch(/resolveCarDocumentType\(/)
    expect(code).toMatch(/file\.size\s*>\s*CAR_DOCUMENT_MAX_BYTES/)
    expect(code).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/)
    expect(code).toMatch(/contentType,\s*\n?\s*upsert:\s*false/)
  })

  it('3. every server writer of the bucket is known and sends a listed type', () => {
    const found = []
    for (const f of walk(path.join(ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8')
      // Cheap raw-text filter first: stripComments only blanks text, so a file
      // whose raw text lacks either token cannot match after stripping (and
      // parsing every src/ file costs more than the default test timeout).
      if (!text.includes("'car-documents'") || !/\.upload\s*\(/.test(text)) continue
      const code = stripComments(text)
      if (!/'car-documents'/.test(code) || !/\.upload\s*\(/.test(code)) continue
      found.push(rel(f))
      const how = WRITERS[rel(f)]
      expect(how, `${rel(f)} uploads into car-documents: add it to WRITERS with the type it sends`).toBeDefined()
      if (how === 'literal') {
        const types = [...code.matchAll(/contentType:\s*'([^']+)'/g)].map((m) => m[1])
        expect(types.length, rel(f)).toBeGreaterThan(0)
        for (const t of types) expect(CAR_DOCUMENT_MIME_TYPES, `${rel(f)} sends ${t}`).toContain(t)
      }
    }
    expect(found.sort()).toEqual(Object.keys(WRITERS).sort())
  })

  it('4. the web picker offers exactly the shared list', () => {
    const code = stripComments(read(PICKER))
    expect(code).toMatch(/accept=\{CAR_DOCUMENT_ACCEPT\}/)
    expect(code).not.toMatch(/accept="/)
  })

  it('5. the signed-upload path is known and judges with the shared rules (CARDOCUPLOAD.1)', () => {
    const found = {}
    for (const f of walk(path.join(ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8')
      if (!text.includes('car-documents') || !/(createSignedUploadUrl|uploadToSignedUrl)\s*\(/.test(text)) continue
      const code = stripComments(text)
      if (!/'car-documents'/.test(code)) continue
      const calls = [...code.matchAll(/\.(createSignedUploadUrl|uploadToSignedUrl)\s*\(/g)].map((m) => m[1])
      if (calls.length) found[rel(f)] = [...new Set(calls)].join(',')
    }
    expect(found, 'a new signed-upload writer of car-documents: add it to SIGNED_WRITERS').toEqual(SIGNED_WRITERS)

    const rules = stripComments(read(UPLOAD_RULES))
    expect(rules).toMatch(/from\s+'\.\/car-document-media'/)
    expect(rules).toMatch(/bytes\s*>\s*CAR_DOCUMENT_MAX_BYTES/)

    for (const f of [SIGN_ROUTE, FINALISE_ROUTE]) {
      const code = stripComments(read(f))
      expect(code, f).toMatch(/resolveCarDocumentType\(/)
      expect(code, f).toMatch(/checkCarDocumentSize\(/)
      expect(code, f).toMatch(/carDocumentsGate\(/)
      expect(code, f).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/)
    }
    // Finalise judges what Storage holds, at a slot minted for this car.
    const fin = stripComments(read(FINALISE_ROUTE))
    expect(fin).toMatch(/isCarDocumentUploadPath\(/)
    expect(fin).toMatch(/sniffCarDocumentHeif\(/)
    expect(fin).toMatch(/metadata\?\.size/)
    expect(fin).toMatch(/metadata\?\.mimetype/)
    // The browser uploads under the type sign decided (the bucket checks it).
    const client = stripComments(read(UPLOAD_CLIENT))
    expect(client).toMatch(/uploadToSignedUrl\(path,\s*token,\s*blob,\s*\{\s*contentType\s*\}\)/)
    expect(client).toMatch(/new Blob\(\[file\],\s*\{\s*type:\s*contentType\s*\}\)/)
    expect(client).toMatch(/checkCarDocumentSize\(/)
  })

  it('the detectors read what they must', () => {
    expect(literalLimit("UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'car-documents'")).toBe(26214400)
    expect(literalLimit("UPDATE storage.buckets SET file_size_limit = NULL WHERE id = 'car-documents'")).toBeNull()
    expect(literalMimes("SET allowed_mime_types = ARRAY['application/pdf', 'image/png'] WHERE")).toEqual(['application/pdf', 'image/png'])
    expect(literalMimes('SET allowed_mime_types = NULL WHERE')).toBeNull()
  })
})
