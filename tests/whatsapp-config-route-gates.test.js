// WAROLE.1 — every WhatsApp MUTATION handler, and the gate it decides on.
//
// The defect this pins: PUT /api/whatsapp/card-sets and
// POST /api/whatsapp/conversational-automation checked only that the caller
// BELONGS to the location, so any staff member there could rewrite the card
// sets Mia sends and the chat openers Meta shows on the studio's number,
// while the number itself (numbers, embedded signup) was master/owner only.
// Both now decide with guardMasterOrOwner at the location written, the rule
// of the settings page they live on.
//
// How it works: each src/app/api/whatsapp/** and
// src/app/api/locations/[id]/whatsapp/** route file is cut into its exported
// handlers; every non-GET handler is classified by the strongest gate CALL in
// its own body (comments blanked first, so a comment naming a guard does not
// count). The table below is EXACT: a new handler, a removed one, or a
// handler whose gate changed fails until the table says so, with a reason.
// This is a floor, not a proof: a gate inside a helper the handler calls is
// invisible (it would read as 'membership').
//
// Comments come from the TypeScript parser, not a regex: a regex that removes
// /* … */ first reads `accept="image/*"` or `// the /api/* routes` as the
// start of a comment and hides everything up to the next */ (C74
// GUARDSTRIP.1). A route file the parser cannot read would be scanned raw, so
// a test below requires every one of them to parse.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const API = path.join(ROOT, 'src/app/api')
const DIRS = [path.join(API, 'whatsapp'), path.join(API, 'locations/[id]/whatsapp')]

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const rel = (file) => path.relative(API, file).split(path.sep).join('/')

const parse = (text) => ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JSX)

// Copied from tests/staff-profile-to-client.test.js (GUARDSTRIP.0): comment
// ranges from the parser, JSX text excluded, each comment blanked to spaces
// (newlines kept, so the `^export` split below still sees line starts).
export function stripComments(text) {
  const sf = parse(text)
  if (sf.parseDiagnostics?.length) return text
  // JSX text is not trivia, but asked for comments at its start the scanner
  // reads `<p>/* note</p>` or `<p>// x</p>` as one and would blank the code
  // after it, so no range is taken at a position where JSX text begins (a
  // wrapper node can share that position, hence the set, not a kind check).
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

// Strongest first. Each test is a CALL shape, not a bare name.
export function classify(handlerSrc) {
  if (/guardMasterOrOwner\(\s*user\b/.test(handlerSrc)) return 'owner'
  if (/hasRoleAtLocation\(\s*user\b[^)]*MANAGER_ROLES/.test(handlerSrc)) return 'manager'
  if (/hasPermissionForLocation\(\s*user\b[^)]*'whatsapp'/.test(handlerSrc)) return 'whatsapp-permission'
  if (/requireInboxPermission\(\s*user\s*,\s*'wa'\s*\)/.test(handlerSrc)) return 'inbox'
  if (/assertLocationAccess(Or404)?\(\s*user\b/.test(handlerSrc)) return 'membership'
  if (!/getCurrentUser\(/.test(handlerSrc)) return 'no-session'
  return 'session-only'
}

export function handlers(src) {
  return stripComments(src)
    .split(/(?=^export async function )/m)
    .map((body) => ({ body, m: body.match(/^export async function (\w+)/) }))
    .filter((x) => x.m)
    .map(({ body, m }) => ({ method: m[1], body }))
}

function actual() {
  const out = {}
  for (const file of DIRS.flatMap(routeFiles)) {
    for (const h of handlers(fs.readFileSync(file, 'utf8'))) {
      if (h.method === 'GET') continue
      out[`${h.method} ${rel(file)}`] = classify(h.body)
    }
  }
  return out
}

// [gate, reason]. 'membership' rows are the ones a follow-up may tighten;
// each says why it is membership-only today.
export const EXPECTED = {
  // ── The number itself and what Meta shows on it: master or owner ──
  'POST locations/[id]/whatsapp/embedded-signup/route.js': ['owner', 'Connects a number through Meta Embedded Signup.'],
  'POST locations/[id]/whatsapp/numbers/route.js': ['owner', 'Registers a Cloud API number (token).'],
  'PATCH locations/[id]/whatsapp/numbers/[numberId]/route.js': ['owner', 'Edits a number, its token, its default flag.'],
  'DELETE locations/[id]/whatsapp/numbers/[numberId]/route.js': ['owner', 'Removes a number.'],
  'POST whatsapp/conversational-automation/route.js': ['owner', 'WAROLE.1: sets the welcome event + ice breakers AT META on the number.'],
  'PUT whatsapp/card-sets/route.js': ['owner', 'WAROLE.1: replaces the carousel card sets staff and Mia send.'],

  // ── Templates ──
  'POST whatsapp/templates/[id]/resubmit/route.js': ['manager', 'Edits a rejected/paused template at Meta.'],
  'POST whatsapp/templates/route.js': ['membership', 'Creates a template and submits it to Meta. Not tightened here (row C79 WATPLROLE.1).'],
  'PUT whatsapp/templates/[id]/route.js': ['membership', 'Local fields only (name, category, display group). Not tightened here (row C79 WATPLROLE.1).'],
  'DELETE whatsapp/templates/[id]/route.js': ['membership', 'Deletes the template AT META by name. Not tightened here (row C79 WATPLROLE.1).'],
  'POST whatsapp/templates/upload-media/route.js': ['membership', 'Uploads header media for a template draft (no Meta state).'],
  'POST whatsapp/templates/upload-media/sign/route.js': ['membership', 'Signs a storage upload for template media (no Meta state).'],

  // ── Broadcasts: drafting is membership, SENDING needs the whatsapp permission ──
  'POST whatsapp/broadcasts/route.js': ['membership', 'Creates a draft; nothing is sent.'],
  'PUT whatsapp/broadcasts/[id]/route.js': ['membership', 'Edits a draft/scheduled broadcast.'],
  'DELETE whatsapp/broadcasts/[id]/route.js': ['membership', 'Deletes a broadcast row.'],
  'POST whatsapp/broadcasts/[id]/pause/route.js': ['membership', 'Pauses/resumes a drip (stopping sends is never the risk).'],
  'POST whatsapp/broadcasts/[id]/send/route.js': ['whatsapp-permission', 'Sends to the audience.'],

  // ── The inbox: the whatsapp channel permission (INBOX-PERM.1) ──
  'POST whatsapp/conversations/start/route.js': ['inbox', 'Starts a thread.'],
  'PATCH whatsapp/conversations/[id]/route.js': ['inbox', 'Read/resolve a thread.'],
  'POST whatsapp/conversations/[id]/add-contact/route.js': ['inbox', 'Links a thread to a contact.'],
  'PATCH whatsapp/conversations/[id]/agent/route.js': ['inbox', 'Mia pause / take-over.'],
  'POST whatsapp/conversations/[id]/block/route.js': ['inbox', 'Blocks a sender.'],
  'POST whatsapp/conversations/[id]/react/route.js': ['inbox', 'Reacts to a message.'],
  'POST whatsapp/conversations/[id]/send/route.js': ['inbox', 'Sends a text or an approved template in the thread (WATPLSEND.1: template rows judged, Flow token minted); membership at the thread\'s location after the inbox permission.'],
  'POST whatsapp/conversations/[id]/send-carousel/route.js': ['inbox', 'Sends a card set.'],
  'POST whatsapp/conversations/[id]/send-flow/route.js': ['inbox', 'Sends a Flow.'],

  // ── Meta's own callback ──
  'POST whatsapp/flow/route.js': ['no-session', 'Flow data exchange: the RSA/AES envelope is the credential (check:route-guards EXEMPT).'],
}

describe('WhatsApp mutation handlers — each one\'s gate (WAROLE.1)', () => {
  it('the classifier reads call shapes, strongest first', () => {
    expect(classify('const g = guardMasterOrOwner(user, id)\nassertLocationAccess(user, id)')).toBe('owner')
    expect(classify('if (!hasRoleAtLocation(user, t.location_id, MANAGER_ROLES)) {}')).toBe('manager')
    expect(classify("if (!hasPermissionForLocation(user, row.location_id, 'whatsapp')) {}")).toBe('whatsapp-permission')
    expect(classify("const p = requireInboxPermission(user, 'wa')")).toBe('inbox')
    expect(classify('const g = assertLocationAccessOr404(user, loc)\ngetCurrentUser()')).toBe('membership')
    expect(classify('getCurrentUser()')).toBe('session-only')
    expect(classify('const x = 1')).toBe('no-session')
  })

  it('a comment naming a guard is not a gate (line, block and trailing comments)', () => {
    const body = (gate) => `export async function PUT() {\n  const user = await getCurrentUser()\n  ${gate}\n  const g = assertLocationAccessOr404(user, loc)\n}\n`
    for (const gate of [
      '// guardMasterOrOwner(user, loc)',
      '/* guardMasterOrOwner(user, loc) */',
      '/**\n   * guardMasterOrOwner(user, loc)\n   */',
      'const n = 1 // guardMasterOrOwner(user, loc)',
    ]) expect([gate, handlers(body(gate)).map((h) => classify(h.body))]).toEqual([gate, ['membership']])
  })

  it('a "/*" inside a string or a regex hides no code from the scan (C74 GUARDSTRIP.1)', () => {
    for (const lead of ["const accept = 'image/*'", 'const re = /api\\/*/', 'const t = `/api/* routes`']) {
      // the later block comment gives a regex a */ to run to
      const src = `export async function PUT() {\n  ${lead}\n  const g = guardMasterOrOwner(user, loc)\n  /* done */\n}\n`
      expect([lead, handlers(src).map((h) => classify(h.body))]).toEqual([lead, ['owner']])
    }
  })

  it('handlers() splits a file per exported handler', () => {
    const src = 'export async function GET() { a() }\nexport async function PUT() { guardMasterOrOwner(user, x) }\n'
    expect(handlers(src).map((h) => [h.method, classify(h.body)])).toEqual([['GET', 'no-session'], ['PUT', 'owner']])
  })

  it('every route file parses (an unparseable file would be scanned with its comments)', () => {
    const broken = DIRS.flatMap(routeFiles).filter((f) => parse(fs.readFileSync(f, 'utf8')).parseDiagnostics?.length).map(rel)
    expect(broken).toEqual([])
  })

  it('every mutation handler is in the table, with the gate the table says (exact)', () => {
    const got = actual()
    const want = Object.fromEntries(Object.entries(EXPECTED).map(([k, [gate]]) => [k, gate]))
    expect(got).toEqual(want)
  })

  it('every handler is an `export async function` (any other export shape would be skipped)', () => {
    const odd = DIRS.flatMap(routeFiles)
      .filter((f) => /^export\s+(const|let|var|function|\{)|^export\s+async\s+(?!function\b)/m.test(stripComments(fs.readFileSync(f, 'utf8'))
        .replace(/^export\s+const\s+(dynamic|runtime|revalidate|maxDuration|fetchCache|preferredRegion)\s*=.*$/gm, '')))
      .map(rel)
    expect(odd).toEqual([])
  })

  it('what Meta shows on the number is master/owner, like the number itself', () => {
    const got = actual()
    for (const k of [
      'POST whatsapp/conversational-automation/route.js',
      'PUT whatsapp/card-sets/route.js',
      'POST locations/[id]/whatsapp/numbers/route.js',
      'POST locations/[id]/whatsapp/embedded-signup/route.js',
    ]) expect([k, got[k]]).toEqual([k, 'owner'])
  })

  it('every row carries a reason', () => {
    for (const [k, [, reason]] of Object.entries(EXPECTED)) expect([k, reason.length > 10]).toEqual([k, true])
  })
})
