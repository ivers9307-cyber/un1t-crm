// WACONFIGFALLBACK.1 — every caller of a WhatsApp config resolver, and what
// it does when the location has no WhatsApp number of its own.
//
// The defect this pins: getWhatsAppConfig(locationId) fell back to the global
// WHATSAPP_* env number when a location had no active whatsapp_numbers row
// (5 of 6 active locations on 30 Sep 2026), and four template routes named no
// location at all, so they ALWAYS used it. A send, a template write, a block
// or a media fetch "for" such a location acted on another studio's number,
// and a customer's reply routed to that studio's inbox and Mia. The env tier
// is retired: the resolvers throw WhatsAppNumberMissingError
// (src/lib/whatsapp-number-missing.js) and each caller decides what that
// means for it. This table is that decision, one row per calling file.
//
// What is scanned: every .js/.jsx/.mjs file under src/, shared/ and scripts/
// except tests and test helpers. A file is a CALLER when it imports one of
// the resolving names below from src/lib/whatsapp.js,
// src/lib/whatsapp-config.js or src/lib/whatsapp-own-number.js (a static
// import, or `const { … } = await import(…)`), and the row counts its CALLS of
// each imported name (aliases followed). The table is EXACT: a new caller, a
// removed one or a changed count fails until a row says what the caller does
// with a refusal, and why.
//
// The resolving names are not hand-kept only: every exported function in
// whatsapp.js whose body calls resolveConfig( or getWhatsAppConfig( must be
// in RESOLVING, so a new Meta helper cannot slip past the table.
//
// How calls are found: each file is parsed with the TypeScript parser; import
// bindings come from the AST; calls are counted in the text with comments
// (stripComments, copied from tests/staff-profile-to-client.test.js, JSX text
// positions excluded) and the contents of string / template / regex literals
// blanked (as tests/whatsapp-config-route-gates.test.js does), so a name in a
// comment or a string never counts. A namespace import (`import * as wa`) or
// an `import()` of these modules in any other shape fails its own test, and
// so does a re-export of one (`export { … } from`, `export * from`), which
// would let a barrel hide its callers. A destructured `process.env` read of a
// retired var counts as a read.
//
// A FLOOR, NOT A PROOF. Not detected: a call through a variable
// (`const f = sendTextMessage; f()`), a caller that passes the wrong location,
// and what a WRAPPER's callers do (a wrapper's row covers them: e.g.
// maybeSendBookingWhatsappConfirm never throws, so every booking path that
// calls it inherits "quiet sent:false"). The per-caller tests named in each
// row are the proof.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'scripts'].map((d) => path.join(ROOT, d))
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

// Module (repo path without extension) → the names that resolve a config.
const RESOLVING = {
  'src/lib/whatsapp': [
    'sendTextMessage', 'sendInteractiveOptions', 'sendFlowMessage', 'sendCtaUrlMessage', 'sendMediaCarousel',
    'sendTemplateMessage', 'sendMediaMessage', 'sendReaction', 'markAsRead', 'sendTypingIndicator',
    'setWhatsAppUserBlockState', 'setConversationalAutomation', 'uploadMediaForTemplate', 'createTemplate',
    'getTemplates', 'getTemplate', 'deleteTemplate', 'editTemplate', 'sendBroadcast', 'sendDripChunk',
  ],
  'src/lib/whatsapp-config': [
    'getWhatsAppConfig', 'getLocationWhatsAppNumberConfig', 'getWhatsAppConfigById', 'resolveWhatsAppNumberByPhoneNumberId',
    'getConversationReplyConfig', 'getConversationNumberConfig',
  ],
  'src/lib/whatsapp-own-number': ['ownNumberOrRefusal'],
}

// Decisions:
//   refuse-409     staff route: a refusal is a 409 with the resolver's message
//                  (whatsappErrorStatus / ownNumberOrRefusal), nothing written
//   own-number     acts AT META for one location: resolves THAT location's own
//                  number first (ownNumberOrRefusal / getLocationWhatsAppNumberConfig)
//   refuse-quiet   automated, best-effort: the existing try/catch turns the
//                  refusal into { sent:false } / a skip, logged, never thrown
//   refuse-skip    automated with a runner: a recorded skip or a pause, never
//                  a throw that could kill other work
//   inbound-owner  replies to inbound; the webhook only routes inbound to a
//                  location that owns the receiving number, so a refusal means
//                  the number was removed mid-flight (then refuse-quiet)
//   resolver       the resolution layer itself
const CALLERS = {
  'src/lib/whatsapp.js': {
    calls: { getWhatsAppConfig: 3, getConversationReplyConfig: 1 },
    decision: 'resolver',
    why: 'resolveConfig (every Meta helper; opts.replyInConversation → getConversationReplyConfig, which falls back to getWhatsAppConfig and so refuses a number-less studio the same way: WAREPLYNUMBER.1, whatsapp-reply-number.test.js), sendBroadcast (blast: throws BEFORE the status flip → route 409 / cron pushes managers), sendDripChunk (pauses the drip). src/lib/whatsapp-no-number-senders.test.js, whatsapp-no-number-broadcasts.test.js.',
  },
  'src/lib/whatsapp-own-number.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'resolver',
    why: 'ownNumberOrRefusal: 409 no number / 500 lookup failed. whatsapp-own-number.test.js.',
  },
  'src/lib/whatsapp-media-server.js': {
    calls: { getLocationWhatsAppNumberConfig: 1 },
    decision: 'own-number',
    why: 'inbound media fetched with the message location’s own token; none → null (the inbox’s graceful gap). whatsapp-media-server.test.js.',
  },
  'src/app/api/webhooks/whatsapp/route.js': {
    calls: { resolveWhatsAppNumberByPhoneNumberId: 2 },
    decision: 'resolver',
    why: 'inbound routing: only an active row owns inbound (classifyInboundOwner); the env branch is gone (it could only produce a location-less config, which was dropped anyway).',
  },
  'src/app/api/whatsapp/conversational-automation/route.js': {
    calls: { setConversationalAutomation: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'chat openers on the location’s own number (C33 WAROLE.1), 409 / 500 before Meta.',
  },
  'src/app/api/whatsapp/templates/route.js': {
    calls: { createTemplate: 1, getTemplates: 1, ownNumberOrRefusal: 2 },
    decision: 'own-number',
    why: 'create: 409 / 500 before Meta (it named no location, so it always used the env WABA). Sync: sync_error, Meta not called, cache served (it copied the env WABA’s templates into a number-less location). route.own-number.test.js.',
  },
  'src/app/api/whatsapp/templates/[id]/route.js': {
    calls: { deleteTemplate: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'Meta delete-by-name on the template location’s own WABA (it always deleted on the env WABA). No number → Meta skipped, local row deleted; lookup failed → 500, row kept. route.own-number.test.js.',
  },
  'src/app/api/whatsapp/templates/[id]/resubmit/route.js': {
    calls: { editTemplate: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'edit with the template location’s own number (it always used the env token); 409 / 500 before Meta. route.own-number.test.js.',
  },
  'src/app/api/whatsapp/templates/upload-media/route.js': {
    calls: { uploadMediaForTemplate: 1, ownNumberOrRefusal: 1 },
    decision: 'own-number',
    why: 'header upload with the location’s own app + token (it always used the env app). Soft contract kept: URL returned, handle null, meta_error says why. route.own-number.test.js.',
  },
  'src/app/api/contacts/[id]/whatsapp/route.js': {
    calls: { sendTextMessage: 1, sendTemplateMessage: 1, ownNumberOrRefusal: 1, getConversationNumberConfig: 1 },
    decision: 'refuse-409',
    why: 'contact composer: own number checked BEFORE a thread is opened (no empty thread); the send carries that checked { config } (one lookup, no check-then-send gap), or the thread\'s own number while it is active here (WAREPLYNUMBER.1: getConversationNumberConfig never throws, null → the checked default; a template only within the default\'s WABA). route.test.js.',
  },
  'src/app/api/contacts/[id]/cancellation-form/route.js': {
    calls: { sendCtaUrlMessage: 1, sendTemplateMessage: 1, ownNumberOrRefusal: 1 },
    decision: 'refuse-409',
    why: 'WhatsApp channel only: own number checked before a thread or a link, and the send carries that checked { config }; email unaffected. route.test.js.',
  },
  'src/app/api/churn-radar/action/route.js': {
    calls: { sendTextMessage: 1 },
    decision: 'refuse-409',
    why: 'win-back: 409 with the resolver message (the copy blamed the member’s message window); outreach via sendRadarOutreach: 409. route.no-number.test.js.',
  },
  'src/app/api/whatsapp/broadcasts/[id]/send/route.js': {
    calls: { sendBroadcast: 1 },
    decision: 'refuse-409',
    why: 'blast refused before any status flip → 409. route.test.js.',
  },
  'src/app/api/cron/run-whatsapp-broadcasts/route.js': {
    calls: { sendDripChunk: 2, sendBroadcast: 3 },
    decision: 'refuse-skip',
    why: 'scheduled blast or (C138 b) scheduled drip start refusal: row stays draft, managers pushed; drip: paused by sendDripChunk (no error loop); a resumed chunked blast logs per tick (existing path).',
  },
  'src/app/api/whatsapp/conversations/[id]/send/route.js': {
    calls: { sendTemplateMessage: 1, sendMediaMessage: 1, sendTextMessage: 1 },
    decision: 'refuse-409',
    why: 'inbox reply: 409, nothing logged (it replied from another studio’s number, so the answer went to that studio). route.test.js.',
  },
  'src/app/api/whatsapp/conversations/[id]/react/route.js': {
    calls: { sendReaction: 1 },
    decision: 'refuse-409',
    why: '409, no thread row. conversations/[id]/no-number.test.js.',
  },
  'src/app/api/whatsapp/conversations/[id]/block/route.js': {
    calls: { setWhatsAppUserBlockState: 1 },
    decision: 'refuse-409',
    why: '409, nothing mirrored (the env Block API blocked the sender on ANOTHER studio’s number). no-number.test.js.',
  },
  'src/app/api/whatsapp/conversations/[id]/send-flow/route.js': {
    calls: { sendFlowMessage: 1 },
    decision: 'refuse-409',
    why: '409, no thread row. no-number.test.js.',
  },
  'src/lib/whatsapp-carousel-send.js': {
    calls: { sendMediaCarousel: 1 },
    decision: 'refuse-409',
    why: 'wrapper: throws before the thread row. Staff send-carousel route → 409 (no-number.test.js); Mia’s send_card_set tool → its tool-error path (inbound-owner).',
  },
  'src/lib/agent/auto-reply.js': {
    calls: { sendTypingIndicator: 1, sendCtaUrlMessage: 1, sendTextMessage: 1, sendInteractiveOptions: 1 },
    decision: 'inbound-owner',
    why: 'Mia replies to inbound, which only reaches a location that owns the receiving number. A refusal = number removed mid-flight → the agent’s existing send-failure path.',
  },
  'src/lib/agent/welcome-greeting.js': {
    calls: { sendTextMessage: 1 },
    decision: 'inbound-owner',
    why: 'never throws → { sent:false }. welcome-greeting.test.js.',
  },
  'src/lib/whatsapp-consent.js': {
    calls: { sendTextMessage: 1 },
    decision: 'inbound-owner',
    why: 'STOP/START ack only; the consent change is written first and stands (louder-failure rule). whatsapp-consent.test.js.',
  },
  'src/lib/agent/notify.js': {
    calls: { sendTextMessage: 1 },
    decision: 'refuse-quiet',
    why: 'Mia confirmations into an EXISTING thread at its location; caught → { sent:false, reason }. Unreachable at a location that never had a number (no threads there).',
  },
  'src/lib/agent/followups.js': {
    calls: { sendTextMessage: 2, sendTemplateMessage: 2 },
    decision: 'refuse-quiet',
    why: 'Mia nudges / first-class check-ins: only at locations with the agent enabled, into existing threads or with location-owned templates; per-contact catch → skipped, counted.',
  },
  'src/lib/automations/booking-whatsapp-confirm.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'booking + event confirmations (class, consult, EVENTCONFIRM-WA): never throws → send_failed, logged; needs a location-owned APPROVED template first. booking-whatsapp-confirm.test.js.',
  },
  'src/lib/automations/meta-ad-whatsapp-welcome.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'paid-ad lead welcome: never throws → send_failed, logged; needs a location-owned template first.',
  },
  'src/lib/cancellation-form/confirm.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-quiet',
    why: 'membership outcome template fallback: caught → { sent:false, reason:"send_error" }; needs an existing thread + a location-owned template.',
  },
  'src/lib/radar-outreach.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-409',
    why: 'wrapper: rethrows; the churn / lead radar routes answer 409 (route.no-number.test.js).',
  },
  'src/lib/sequences/steps.js': {
    calls: { sendTemplateMessage: 1 },
    decision: 'refuse-skip',
    why: 'recorded skip + structured warning, never a throw (a throw can auto-pause the enrolment and kill its email steps). wa-no-number-step.test.js.',
  },
}

const DECISIONS = new Set(['refuse-409', 'own-number', 'refuse-quiet', 'refuse-skip', 'inbound-owner', 'resolver'])

const parse = (text) => ts.createSourceFile('scan.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)

const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
])

// Comments (stripComments of tests/staff-profile-to-client.test.js: TypeScript
// comment ranges, none taken where JSX text begins) plus every literal's text,
// blanked to spaces with newlines kept.
export function blankNonCode(text, sf = parse(text)) {
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

// '@/lib/x', './x', '../x.js' → repo path without extension, or null.
function resolveSpecifier(fromFile, spec) {
  let abs
  if (spec.startsWith('@/')) abs = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) abs = path.resolve(path.dirname(fromFile), spec)
  else return null
  return rel(abs).replace(/\.(m?js|jsx)$/, '')
}

const isDynamicImport = (node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword

// → { bindings: Map(localName → exportedName), problems: [] }
export function importBindings(file, text, sf = parse(text)) {
  const bindings = new Map()
  const problems = []
  const target = (spec) => {
    const mod = resolveSpecifier(file, spec)
    return mod && RESOLVING[mod] ? mod : null
  }
  const take = (mod, exported, local) => {
    if (RESOLVING[mod].includes(exported)) bindings.set(local, exported)
  }
  const handledDynamic = new Set()
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = target(node.moduleSpecifier.text)
      const nb = node.importClause?.namedBindings
      if (mod && nb) {
        if (ts.isNamespaceImport(nb)) problems.push(`namespace import of ${mod}: import the names`)
        else for (const el of nb.elements) take(mod, (el.propertyName || el.name).text, el.name.text)
      }
    }
    // A re-export (`export { x as y } from …`, `export * from …`) would let a
    // barrel's callers reach a resolver under a name this table never binds.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = target(node.moduleSpecifier.text)
      if (mod) problems.push(`re-export of ${mod}: import the names where they are called`)
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer)
      && isDynamicImport(node.initializer.expression)) {
      const call = node.initializer.expression
      const arg = call.arguments[0]
      const mod = arg && ts.isStringLiteral(arg) ? target(arg.text) : null
      if (mod) {
        handledDynamic.add(call)
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) take(mod, (el.propertyName || el.name).text, el.name.text)
        } else problems.push(`dynamic import of ${mod} not destructured`)
      }
    }
    if (isDynamicImport(node) && !handledDynamic.has(node)) {
      const arg = node.arguments[0]
      const mod = arg && ts.isStringLiteral(arg) ? target(arg.text) : null
      if (mod) problems.push(`dynamic import of ${mod} in an unsupported shape`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { bindings, problems }
}

export function countCalls(text, bindings, sf = parse(text)) {
  if (bindings.size === 0) return {}
  const code = blankNonCode(text, sf)
  const out = {}
  for (const [local, exported] of bindings) {
    const n = [...code.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))].length
    if (n) out[exported] = (out[exported] || 0) + n
  }
  return out
}

function sourceFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '.next'].includes(entry.name)) continue
      out.push(...sourceFiles(full))
    } else if (/\.(m?js|jsx)$/.test(entry.name) && !/\.test\.|\.test-helpers?\./.test(entry.name)) out.push(full)
  }
  return out
}

// Every scanned file is read and parsed ONCE per run and shared by both
// whole-repo tests: a TypeScript parse of the whole tree per `it` is what
// timed another guard out at vitest's 5 s default on the CI runner, so the
// whole-repo describes below also carry their own timeout.
const WHOLE_REPO_TIMEOUT_MS = 120_000
let cachedSources = null
function sources() {
  if (!cachedSources) {
    cachedSources = SCAN_DIRS.flatMap(sourceFiles).map((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return { file, text, sf: parse(text) }
    })
  }
  return cachedSources
}

let cachedScan = null
function scan() {
  if (cachedScan) return cachedScan
  const found = {}
  const problems = []
  for (const { file, text, sf } of sources()) {
    const { bindings, problems: p } = importBindings(file, text, sf)
    for (const msg of p) problems.push(`${rel(file)}: ${msg}`)
    // whatsapp.js resolves through its own import of getWhatsAppConfig.
    const calls = countCalls(text, bindings, sf)
    if (Object.keys(calls).length) found[rel(file)] = calls
  }
  cachedScan = { found, problems }
  return cachedScan
}

describe('WACONFIGFALLBACK.1 — every config-resolver caller has a decision', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  it('no namespace or unsupported dynamic import of the resolver modules', () => {
    expect(scan().problems).toEqual([])
  })

  it('the caller table is exact (files and call counts)', () => {
    const { found } = scan()
    const table = Object.fromEntries(Object.entries(CALLERS).map(([f, r]) => [f, r.calls]))
    expect(found).toEqual(table)
  })

  it('every row names a known decision and a reason', () => {
    for (const [file, row] of Object.entries(CALLERS)) {
      expect([file, DECISIONS.has(row.decision)]).toEqual([file, true])
      expect([file, row.why.length > 20]).toEqual([file, true])
    }
  })

  it('RESOLVING covers every exported whatsapp.js function that resolves a config', () => {
    const file = path.join(ROOT, 'src/lib/whatsapp.js')
    const text = fs.readFileSync(file, 'utf8')
    const sf = parse(text)
    const resolving = []
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const body = blankNonCode(text, sf).slice(st.getStart(sf), st.end)
        if (/(?<![\w$.])(resolveConfig|getWhatsAppConfig)\s*\(/.test(body)) resolving.push(st.name.text)
      }
    }
    expect(resolving.sort()).toEqual([...RESOLVING['src/lib/whatsapp']].sort())
  })
})

describe('WACONFIGFALLBACK.1 — the env tier is retired', { timeout: WHOLE_REPO_TIMEOUT_MS }, () => {
  const RETIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID']

  // process.env.X or process.env['X'] — read from the AST, so a comment or an
  // error message naming the variable does not count.
  function envReads(text, sf = parse(text)) {
    const out = []
    const isProcessEnv = (e) => ts.isPropertyAccessExpression(e) && e.name.text === 'env'
      && ts.isIdentifier(e.expression) && e.expression.text === 'process'
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) out.push(node.name.text)
      if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) out.push(node.argumentExpression.text)
      // const { WHATSAPP_ACCESS_TOKEN } = process.env (renamed or not)
      if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName || el.name
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) out.push(key.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  it('no scanned source reads the global WhatsApp number env vars', () => {
    const readers = []
    for (const { file, text, sf } of sources()) {
      const names = envReads(text, sf).filter((n) => RETIRED.includes(n))
      if (names.length) readers.push(`${rel(file)}: ${names.join(', ')}`)
    }
    expect(readers).toEqual([])
  })

  it('the scanner sees both env read shapes (canary)', () => {
    expect(envReads("const a = process.env.WHATSAPP_ACCESS_TOKEN; const b = process.env['WHATSAPP_PHONE_NUMBER_ID']"))
      .toEqual(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'])
    expect(envReads('// process.env.WHATSAPP_ACCESS_TOKEN\nconst s = "process.env.WHATSAPP_ACCESS_TOKEN"')).toEqual([])
  })

  it('the scanner sees a destructured env read, renamed or not (canary)', () => {
    expect(envReads('const { WHATSAPP_ACCESS_TOKEN } = process.env')).toEqual(['WHATSAPP_ACCESS_TOKEN'])
    expect(envReads('const { WHATSAPP_PHONE_NUMBER_ID: pni, OTHER } = process.env')).toEqual(['WHATSAPP_PHONE_NUMBER_ID', 'OTHER'])
  })
})

describe('the scanner itself (canaries)', () => {
  const F = path.join(ROOT, 'src/app/api/x/route.js')

  it('follows aliases and counts calls, not mentions in comments or strings', () => {
    const text = [
      "import { sendTextMessage as sendWa, isWindowOpen } from '@/lib/whatsapp'",
      '// sendWa(to, t) in a comment',
      "const s = 'sendWa(x)'",
      'await sendWa(to, text, { locationId })',
      'const t = `${sendWa(a)}`',
    ].join('\n')
    const { bindings } = importBindings(F, text)
    expect([...bindings]).toEqual([['sendWa', 'sendTextMessage']])
    expect(countCalls(text, bindings)).toEqual({ sendTextMessage: 2 })
  })

  it('reads destructured dynamic imports and relative paths', () => {
    const text = "const { sendTemplateMessage } = await import('../../../lib/whatsapp.js')\nawait sendTemplateMessage(a)"
    const { bindings } = importBindings(path.join(ROOT, 'src/app/api/x/route.js'), text)
    expect(countCalls(text, bindings)).toEqual({ sendTemplateMessage: 1 })
  })

  it('fails a namespace import and an undestructured dynamic import', () => {
    expect(importBindings(F, "import * as wa from '@/lib/whatsapp'").problems).toHaveLength(1)
    expect(importBindings(F, "const wa = await import('@/lib/whatsapp')").problems).toHaveLength(1)
    expect(importBindings(F, "(await import('@/lib/whatsapp-config')).getWhatsAppConfig(x)").problems).toHaveLength(1)
  })

  it('fails a re-export of a resolver module (a barrel would hide its callers)', () => {
    expect(importBindings(F, "export { sendTextMessage as sendWa } from '@/lib/whatsapp'").problems).toHaveLength(1)
    expect(importBindings(F, "export * from '@/lib/whatsapp-config'").problems).toHaveLength(1)
    expect(importBindings(F, "export { thing } from '@/lib/other'").problems).toEqual([])
  })

  it('a method of the same name on another object is not a call of the import', () => {
    const text = "import { getTemplate } from '@/lib/whatsapp'\nawait checklists.getTemplate(db, id)"
    const { bindings } = importBindings(F, text)
    expect(countCalls(text, bindings)).toEqual({})
  })

  it('a JSX text that looks like a comment opener does not hide the call after it', () => {
    const text = "import { sendReaction } from '@/lib/whatsapp'\nconst el = <p>// note</p>\nsendReaction(a)"
    const { bindings } = importBindings(F, text)
    expect(countCalls(text, bindings)).toEqual({ sendReaction: 1 })
  })
})
