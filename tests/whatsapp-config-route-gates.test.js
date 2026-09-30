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
// What it covers: every route file under src/app/api/whatsapp/** and
// src/app/api/locations/[id]/whatsapp/**, plus
// src/app/api/contacts/[id]/whatsapp (the one session route outside those
// trees that writes to WhatsApp). The WhatsApp crons and Meta's webhook are
// not session routes; check:route-guards covers them.
//
// How it works: each file is parsed with the TypeScript parser. Its exported
// handlers are taken from the AST (an `export async function`, or an
// exported const arrow / function expression), each one's text sliced from
// its own node, so a helper after the last handler is never folded in.
// Comments and the contents of string, template and regex literals are
// blanked first, so a guard NAMED in a comment or a string does not count;
// code inside a template's ${…} is still code. Every non-GET handler is then
// classified by the strongest gate CALL in that text. The table below is
// EXACT: a new handler, a removed one, or a handler whose gate changed fails
// until the table says so, with a reason. A handler exported in any other
// shape (`export const POST = withAuth(h)`, `export { h as POST }`) fails
// its own test, since its body cannot be judged here.
//
// A FLOOR, NOT A PROOF. Not detected: a gate whose result is ignored
// (`guardMasterOrOwner(user, loc)` with no `if (g) return g`), a gate called
// with the wrong location, a gate reached only on some paths or inside a
// callback, and a gate inside a helper the handler calls (it reads as the
// next gate down, usually 'membership'). The route tests are the proof for
// the rows this PR changed.
//
// Why a parser and not a regex (C74 GUARDSTRIP.1): a regex that removes
// /* … */ first reads `accept="image/*"` or `// the /api/* routes` as the
// start of a comment and hides everything up to the next */. A test below
// requires every scanned file to parse without errors.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const API = path.join(ROOT, 'src/app/api')
const DIRS = [path.join(API, 'whatsapp'), path.join(API, 'locations/[id]/whatsapp')]
const EXTRA = [path.join(API, 'contacts/[id]/whatsapp/route.js')]

function routeFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (entry.name === 'route.js') out.push(full)
  }
  return out
}

const FILES = () => [...DIRS.flatMap(routeFiles), ...EXTRA]

const rel = (file) => path.relative(API, file).split(path.sep).join('/')

const parse = (text) => ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])

// Literal kinds whose TEXT is data, never a call. A template's ${…}
// expressions are separate nodes, so they stay code.
const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
])

// Comment ranges as in tests/staff-profile-to-client.test.js (GUARDSTRIP.0),
// JSX text excluded from the comment scan, plus every literal's text. Each
// range is blanked to spaces with newlines kept, so node offsets still hold.
export function blankNonCode(text, sf = parse(text)) {
  // JSX text is not trivia, but asked for comments at its start the scanner
  // reads `<p>/* note</p>` or `<p>// x</p>` as one and would blank the code
  // after it, so no comment range is taken at a position where JSX text
  // begins (a wrapper node can share that position, hence the set).
  const jsxTextAt = new Set()
  const findJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxTextAt.add(node.pos)
    for (const child of node.getChildren(sf)) findJsxText(child)
  }
  findJsxText(sf)
  const ranges = []
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.push([r.pos, r.end])
    }
    if (LITERALS.has(node.kind)) ranges.push([node.getStart(sf), node.end])
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  const chars = text.split('')
  for (const [pos, end] of ranges) for (let i = pos; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '
  return chars.join('')
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

const isExported = (node) => !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
const isFunctionInit = (init) => !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))

// Classifying reads literal CONTENT as blank, so the gate regexes need their
// own quoted arguments back: 'whatsapp' / 'wa' are restored where they are
// the argument of the permission calls the classifier matches.
function restoreGateArgs(code, text, sf) {
  const chars = code.split('')
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['hasPermissionForLocation', 'requireInboxPermission'].includes(node.expression.text)) {
      for (const a of node.arguments) {
        if (ts.isStringLiteral(a)) for (let i = a.getStart(sf); i < a.end; i++) chars[i] = text[i]
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return chars.join('')
}

// Each exported HTTP handler with its OWN text (comments/literals blanked).
export function handlers(src) {
  const sf = parse(src)
  const code = restoreGateArgs(blankNonCode(src, sf), src, sf)
  const out = []
  for (const st of sf.statements) {
    if (!isExported(st)) continue
    if (ts.isFunctionDeclaration(st) && st.name && METHODS.has(st.name.text)) {
      out.push({ method: st.name.text, body: code.slice(st.getStart(sf), st.end) })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && METHODS.has(d.name.text) && isFunctionInit(d.initializer)) {
          out.push({ method: d.name.text, body: code.slice(d.getStart(sf), d.end) })
        }
      }
    }
  }
  return out
}

// HTTP handlers exported in a shape handlers() cannot judge.
export function unjudgedExports(src) {
  const sf = parse(src)
  const out = []
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && METHODS.has(d.name.text) && !isFunctionInit(d.initializer)) out.push(d.name.text)
      }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (METHODS.has(el.name.text)) out.push(el.name.text)
    }
  }
  return out
}

function actual() {
  const out = {}
  for (const file of FILES()) {
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
  'POST whatsapp/templates/route.js': ['manager', 'WATPLROLE.1: creates a template and submits it to Meta; MANAGER_ROLES at the location created at (the resubmit rule).'],
  'PUT whatsapp/templates/[id]/route.js': ['manager', 'WATPLROLE.1: components, header media, name and category drive what is sent, so MANAGER_ROLES at the template; a display_group-only edit (picker grouping) stays membership. WATPLPUT.1: Meta-owned fields (status, rejection_reason, quality_rating, meta_template_id) are refused (400) and a submitted template\'s content is locked (409).'],
  'DELETE whatsapp/templates/[id]/route.js': ['manager', 'WATPLROLE.1: deletes the template AT META by name; MANAGER_ROLES at the template (the resubmit rule).'],
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

  // ── Outside the two trees ──
  'POST contacts/[id]/whatsapp/route.js': ['whatsapp-permission', 'Sends a WhatsApp to one contact: the whatsapp permission (web or mobile) at the contact\'s location, after membership.'],

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

  // Review probes: a gate NAMED in a string, a template or a regex is not a
  // gate; a helper after the last handler is not part of it; an exported
  // const arrow is a handler like any other.
  it('a guard named in a string, template or regex literal is not a gate', () => {
    const body = (lead) => `export async function PUT() {\n  const user = await getCurrentUser()\n  ${lead}\n  const g = assertLocationAccessOr404(user, loc)\n}\n`
    for (const lead of [
      "const note = 'call guardMasterOrOwner(user, loc) first'",
      'const note = "call guardMasterOrOwner(user, loc) first"',
      'const note = `call guardMasterOrOwner(user, loc) first`',
      'const note = `${a} guardMasterOrOwner(user, loc) ${b} guardMasterOrOwner(user, x)`',
      'const re = /guardMasterOrOwner\\(user, loc\\)/',
    ]) expect([lead, handlers(body(lead)).map((h) => classify(h.body))]).toEqual([lead, ['membership']])
  })

  it("the permission calls keep their quoted argument ('whatsapp', 'wa') through the blanking", () => {
    const src = (call) => `export async function POST() {\n  const user = await getCurrentUser()\n  const g = assertLocationAccessOr404(user, loc)\n  ${call}\n}\n`
    expect(handlers(src("if (!hasPermissionForLocation(user, loc, 'whatsapp')) return no")).map((h) => classify(h.body))).toEqual(['whatsapp-permission'])
    expect(handlers(src("const p = requireInboxPermission(user, 'wa')")).map((h) => classify(h.body))).toEqual(['inbox'])
    expect(handlers(src("const p = requireInboxPermission(user, 'email')")).map((h) => classify(h.body))).toEqual(['membership'])
  })

  it('a real call inside a template substitution still counts', () => {
    const src = 'export async function PUT() {\n  const g = `${guardMasterOrOwner(user, loc)}`\n}\n'
    expect(handlers(src).map((h) => classify(h.body))).toEqual(['owner'])
  })

  it('a helper after the last handler is not folded into it', () => {
    const src = [
      'export async function PUT() {',
      '  const user = await getCurrentUser()',
      '  const g = assertLocationAccessOr404(user, loc)',
      '}',
      '',
      'function unused(user, loc) {',
      '  return guardMasterOrOwner(user, loc)',
      '}',
      '',
      'const alsoUnused = () => guardMasterOrOwner(user, loc)',
    ].join('\n')
    expect(handlers(src).map((h) => [h.method, classify(h.body)])).toEqual([['PUT', 'membership']])
  })

  it('an exported const arrow or function expression is a handler, judged on its own body', () => {
    const src = [
      'export const PUT = async (request) => {',
      '  const user = await getCurrentUser()',
      '  const g = guardMasterOrOwner(user, loc)',
      '}',
      'export const DELETE = async function (request) {',
      '  const user = await getCurrentUser()',
      '  const g = assertLocationAccessOr404(user, loc)',
      '}',
      "export const dynamic = 'force-dynamic'",
    ].join('\n')
    expect(handlers(src).map((h) => [h.method, classify(h.body)])).toEqual([['PUT', 'owner'], ['DELETE', 'membership']])
  })

  it('a handler exported in a shape the scan cannot judge is reported', () => {
    expect(unjudgedExports('export const POST = withAuth(handler)')).toEqual(['POST'])
    expect(unjudgedExports('async function POST() {}\nexport { POST }')).toEqual(['POST'])
    expect(unjudgedExports('async function h() {}\nexport { h as DELETE }')).toEqual(['DELETE'])
    expect(unjudgedExports("export async function POST() {}\nexport const PUT = async () => {}\nexport const runtime = 'nodejs'")).toEqual([])
  })

  it('handlers() splits a file per exported handler', () => {
    const src = 'export async function GET() { a() }\nexport async function PUT() { guardMasterOrOwner(user, x) }\n'
    expect(handlers(src).map((h) => [h.method, classify(h.body)])).toEqual([['GET', 'no-session'], ['PUT', 'owner']])
  })

  it('every route file parses (an unparseable file would be scanned with its comments)', () => {
    const broken = FILES().filter((f) => parse(fs.readFileSync(f, 'utf8')).parseDiagnostics?.length).map(rel)
    expect(broken).toEqual([])
  })

  it('every mutation handler is in the table, with the gate the table says (exact)', () => {
    const got = actual()
    const want = Object.fromEntries(Object.entries(EXPECTED).map(([k, [gate]]) => [k, gate]))
    expect(got).toEqual(want)
  })

  it('no handler is exported in a shape the scan cannot judge', () => {
    const odd = FILES().flatMap((f) => unjudgedExports(fs.readFileSync(f, 'utf8')).map((m) => `${m} ${rel(f)}`))
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

  // WATPLROLE.1 — every template handler that changes what Meta holds or what
  // is sent decides with the resubmit rule: MANAGER_ROLES at the template's
  // (or, on create, the target) location. Header-media upload stays
  // membership: it changes nothing at Meta until a create or resubmit uses it.
  it('template create, edit, delete and resubmit decide with the resubmit rule (MANAGER_ROLES at the location)', () => {
    const got = actual()
    for (const k of [
      'POST whatsapp/templates/route.js',
      'PUT whatsapp/templates/[id]/route.js',
      'DELETE whatsapp/templates/[id]/route.js',
      'POST whatsapp/templates/[id]/resubmit/route.js',
    ]) expect([k, got[k]]).toEqual([k, 'manager'])
  })

  it('every row carries a reason', () => {
    for (const [k, [, reason]] of Object.entries(EXPECTED)) expect([k, reason.length > 10]).toEqual([k, true])
  })
})
