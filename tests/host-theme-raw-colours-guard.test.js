// HOSTTHEME.1 — no raw colours in the host portal.
//
// Every host screen styles itself with the `host-*` theme tokens (and the
// recipes in src/components/host/host-ui.js) so the portal can switch between
// a light and a dark theme. A raw `text-white` / `bg-black` / `text-amber-300`
// is correct in exactly one theme and unreadable in the other, and nothing at
// build time notices. This scans the source and fails on one, with file:line.
//
// What is scanned (walked at test time, so a new host file is covered):
//   1. every non-test .js/.jsx file under src/app/host/ and src/components/host/,
//      EXCEPT HostPublicEvents.jsx and HostPublicExtras.jsx. Those two render a
//      host's PUBLIC page, which is deliberately dark whatever theme the host
//      picked, so raw colours there are correct and out of scope.
//   2. the five shared components that take a `dark` prop only the host portal
//      passes (EventSignupsCard, EventWaitlistPanel, PricingTiersEditor,
//      RegistrationQuestionsEditor, DuplicateEventButton). Staff pages render
//      their other arm with raw un1t-* / palette classes legitimately, so there
//      a forbidden class fails ONLY inside the consequent of a `dark ? A : B`
//      ternary (the A part).
//
// Dark-arm isolation (darkArms): find each `dark ?` (not `?.` / `??`), then scan
// forward tracking quotes, template literals (with `${ }` nesting), and
// ( [ { depth. Nested `?` at depth 0 are counted so the arm ends at the `:`
// that matches `dark ?`, not an inner ternary's. The arm also ends if depth
// goes negative (e.g. a ternary closing a `${ }`). When no end is found, or a
// string never closes, the scan FAILS with "cannot isolate the dark arm at
// file:line" instead of skipping. Limits: JSX text containing a bare
// apostrophe or an unbalanced bracket inside the arm confuses it (it then
// fails loudly, or over-reads, never silently under-reads); only the
// `dark ? :` ternary shape is understood, so a class set under `dark &&` or
// an `if (dark)` would be missed; a class assembled from fragments at runtime
// is invisible. A floor, not proof.
//
// Forbidden: raw white/black text/bg/border/divide/ring/placeholder classes
// (any /NN, any variant prefix), text-/bg-/border-/divide-/ring- classes on the
// red/amber/emerald/green/sky/blue/yellow palettes, `[color-scheme:dark]`, and
// an opacity modifier on a host-* colour (tokens are complete colours).
// Matching is on class-token boundaries, so `bg-black` inside another word
// does not match and `host-*` classes never trip the palette rule.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const HOST_DIRS = ['src/app/host', 'src/components/host']
// Public pages, deliberately dark in both themes.
const PUBLIC_PAGE_FILES = [
  'src/components/host/HostPublicEvents.jsx',
  'src/components/host/HostPublicExtras.jsx',
]
const SHARED_DARK_PROP_FILES = [
  'src/components/EventSignupsCard.jsx',
  'src/components/EventWaitlistPanel.jsx',
  'src/components/PricingTiersEditor.jsx',
  'src/components/RegistrationQuestionsEditor.jsx',
  'src/components/DuplicateEventButton.jsx',
]

// Each entry must still match something in its file, or the test fails (stale).
const ALLOWLIST = [
  { file: 'src/components/host/HostEmailPreviewModal.jsx', class: 'bg-black/60', reason: 'modal scrim stays black in both themes' },
  { file: 'src/components/host/OffSaleConfirmDialog.jsx', class: 'bg-black/60', reason: 'modal scrim stays black in both themes' },
]

const ALPHA = String.raw`(?:\/(?:\d+|\[[\d.]+\]))?`
const FORBIDDEN_RES = [
  new RegExp(String.raw`(?<![\w-])((?:[\w-]+:)*(?:text|bg|border(?:-[xytblrse])?|divide|ring|placeholder)-(?:white|black)${ALPHA})(?![\w-]|\/)`, 'g'),
  new RegExp(String.raw`(?<![\w-])((?:[\w-]+:)*(?:text|bg|border(?:-[xytblrse])?|divide|ring)-(?:red|amber|emerald|green|sky|blue|yellow)-\d{2,3}${ALPHA})(?![\w-]|\/)`, 'g'),
  /(?<![\w-])((?:[\w-]+:)*\[color-scheme:dark\])/g,
  // A host-* colour with an opacity modifier.
  /(?<![\w-])((?:[\w-]+:)*(?:text|bg|border(?:-[xytblrse])?|divide|ring|placeholder)-host-[\w-]+\/(?:\d+|\[[\d.]+\]))(?![\w-])/g,
]

/** Forbidden class tokens in `text`, as [{ index, cls }]. */
function findForbidden(text) {
  const out = []
  for (const re of FORBIDDEN_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) out.push({ index: m.index, cls: m[1] })
  }
  return out.sort((a, b) => a.index - b.index)
}

// Index just past the closing quote of the string starting at i.
function skipQuoted(src, i) {
  const q = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === q) return j + 1
    else if (src[j] === '\n' && q !== '`') return -1
  }
  return -1
}

// Index just past the template literal starting at i (handles ${ } nesting).
function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === '`') return j + 1
    else if (src[j] === '$' && src[j + 1] === '{') {
      const end = scanExpr(src, j + 2, true)
      if (end.stop < 0) return -1
      j = end.stop // points at the closing }
    }
  }
  return -1
}

// Scan an expression from `start`. Stops at an unmatched closer (inTemplate:
// the `}` closing the `${`) or, when !inTemplate, at the `:` that ends a
// ternary arm. Returns { stop } (index of the stopping char) or { stop: -1 }.
function scanExpr(src, start, inTemplate) {
  let depth = 0
  let pending = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"') {
      const end = skipQuoted(src, i)
      if (end < 0) return { stop: -1 }
      i = end - 1
    } else if (c === '`') {
      const end = skipTemplate(src, i)
      if (end < 0) return { stop: -1 }
      i = end - 1
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return inTemplate && c === '}' ? { stop: i } : { stop: i, closer: true }
      depth--
    } else if (c === '?') {
      if (src[i + 1] === '.' || src[i + 1] === '?') i++
      else if (depth === 0) pending++
    } else if (c === ':' && depth === 0 && !inTemplate) {
      if (pending > 0) pending--
      else return { stop: i }
    }
  }
  return { stop: -1 }
}

/**
 * The consequent of every `dark ? A : B` in `src`, as [{ start, end }] (A's
 * range). Throws an Error naming file:line when an arm cannot be isolated.
 */
function darkArms(src, file = 'file') {
  const arms = []
  const re = /(?<![\w.$])dark\s*\?(?![.?])/g
  let m
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length
    const { stop } = scanExpr(src, start, false)
    if (stop < 0) {
      const line = src.slice(0, m.index).split('\n').length
      throw new Error(`cannot isolate the dark arm at ${file}:${line}`)
    }
    arms.push({ start, end: stop })
  }
  return arms
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length

/** Offences [{ line, cls }] in a whole file, or only in its dark arms. */
function scanSource(src, { darkOnly = false, file = 'file' } = {}) {
  const found = []
  if (!darkOnly) {
    for (const f of findForbidden(src)) found.push({ line: lineOf(src, f.index), cls: f.cls })
  } else {
    for (const { start, end } of darkArms(src, file)) {
      for (const f of findForbidden(src.slice(start, end))) {
        found.push({ line: lineOf(src, start + f.index), cls: f.cls })
      }
    }
  }
  return found
}

/**
 * Apply an allowlist. Returns { offences, stale }: offences not covered by an
 * entry, and entries (for files in `scanned`) that matched nothing.
 */
function applyAllowlist(results, allowlist) {
  const used = new Set()
  const offences = []
  for (const r of results) {
    const idx = allowlist.findIndex((a) => a.file === r.file && a.class === r.cls)
    if (idx >= 0) used.add(idx)
    else offences.push(r)
  }
  const stale = allowlist.filter((_, i) => !used.has(i))
  return { offences, stale }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

function scanTree() {
  const hostFiles = HOST_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
    .map(rel)
    .filter((f) => !PUBLIC_PAGE_FILES.includes(f))
  const results = []
  const errors = []
  for (const file of hostFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const o of scanSource(src, { file })) results.push({ file, ...o })
  }
  for (const file of SHARED_DARK_PROP_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    try {
      for (const o of scanSource(src, { darkOnly: true, file })) results.push({ file, ...o })
    } catch (e) {
      errors.push(e.message)
    }
  }
  return { hostFiles, results, errors }
}

describe('host portal has no raw colours', () => {
  const { hostFiles, results, errors } = scanTree()

  it('scans the host tree (and not the public pages)', () => {
    expect(hostFiles.length).toBeGreaterThan(30)
    for (const p of PUBLIC_PAGE_FILES) expect(hostFiles).not.toContain(p)
    expect(hostFiles).toContain('src/components/host/host-ui.js')
  })

  it('isolates the dark arm of every shared component', () => {
    expect(errors).toEqual([])
    for (const file of SHARED_DARK_PROP_FILES) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(darkArms(src, file).length, file).toBeGreaterThan(0)
    }
  })

  it('has no forbidden class (path:line  class)', () => {
    const { offences } = applyAllowlist(results, ALLOWLIST)
    expect(offences.map((o) => `${o.file}:${o.line}  ${o.cls}`)).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const { stale } = applyAllowlist(results, ALLOWLIST)
    expect(stale.map((a) => `${a.file}  ${a.class}`)).toEqual([])
    for (const a of ALLOWLIST) expect(a.reason, `${a.file} ${a.class}`).toBeTruthy()
  })
})

describe('the matcher', () => {
  const classes = (s) => findForbidden(s).map((f) => f.cls)

  it('catches every forbidden family, with variants and opacity', () => {
    for (const c of [
      'text-white', 'text-black', 'bg-black', 'bg-white', 'border-white', 'divide-white', 'ring-white',
      'text-white/80', 'bg-white/[0.03]', 'border-white/10', 'bg-black/60',
      'hover:text-white', 'focus:border-white/40', 'disabled:bg-white/5', 'sm:hover:text-white/70',
      'placeholder:text-white/30', 'text-red-300', 'bg-amber-500/10', 'border-emerald-400/30',
      'text-green-700', 'text-sky-300', 'bg-blue-600', 'text-yellow-300', 'hover:bg-red-500',
      '[color-scheme:dark]', 'bg-host-panel/50', 'hover:text-host-text/80', 'border-host-border/[0.5]',
    ]) {
      expect(classes(`className="a ${c} b"`), c).toEqual([c])
    }
  })

  it('lets allowed classes and look-alikes through', () => {
    for (const c of [
      'bg-host-panel', 'text-host-text', 'hover:bg-host-hover', 'border-host-border', 'placeholder:text-host-faint',
      'text-un1t-text', 'bg-un1t-surface', 'blackboard', 'bg-blackish', 'text-whitespace', 'my-bg-black',
      'text-redacted', 'bg-bluey-300', 'opacity-50', 'bg-host-accent text-host-on-accent',
    ]) {
      expect(classes(`className="${c}"`), c).toEqual([])
    }
  })

  it('reports the line of a class', () => {
    expect(scanSource('a\nb\n<p className="x text-white">')).toEqual([{ line: 3, cls: 'text-white' }])
  })
})

describe('dark-arm isolation', () => {
  const only = (src) => scanSource(src, { darkOnly: true }).map((o) => o.cls)

  it('returns only the dark arm of a simple ternary', () => {
    expect(only(`const a = dark ? 'text-white' : 'text-black'`)).toEqual(['text-white'])
    expect(only(`const a = dark ? 'text-host-text' : 'text-black bg-white'`)).toEqual([])
  })

  it('handles a multi-line arm and a template literal', () => {
    const src = [
      'const c = dark',
      "  ? 'rounded border-host-border bg-white/5 ' +",
      "    'p-2'",
      "  : 'bg-white text-black'",
    ].join('\n')
    expect(scanSource(src, { darkOnly: true })).toEqual([{ line: 2, cls: 'bg-white/5' }])
    expect(only('x = dark ? `a ${y ? "b" : "c"} text-red-300` : `text-white`')).toEqual(['text-red-300'])
  })

  it('ends at the matching colon of a nested ternary, in either arm', () => {
    expect(only(`x = dark ? (a ? 'text-white' : 'bg-black') : 'text-black'`)).toEqual(['text-white', 'bg-black'])
    expect(only(`x = dark ? a ? 'text-host-text' : 'text-host-hint' : 'text-black'`)).toEqual([])
    expect(only(`x = dark ? 'text-host-text' : a ? 'text-black' : 'bg-white'`)).toEqual([])
    expect(only(`x = dark ? foo?.bar ?? 'bg-black' : 'x'`)).toEqual(['bg-black'])
  })

  it('handles a ternary inside a template and an object arm', () => {
    expect(only("x = `a ${dark ? 'text-white' : 'text-host-text'} b`")).toEqual(['text-white'])
    expect(only("x = dark ? { a: 'bg-black', b: 'x' } : { a: 'bg-white' }")).toEqual(['bg-black'])
  })

  it('does not treat other identifiers or optional chaining as the dark ternary', () => {
    expect(only(`x = isdark ? 'text-white' : 'y'; z = props.dark ? 'text-white' : 'y'; w = dark?.a`)).toEqual([])
  })

  it('fails loudly when the arm cannot be isolated', () => {
    expect(() => darkArms("x = dark ? 'text-white", 'src/x.jsx')).toThrow('cannot isolate the dark arm at src/x.jsx:1')
    expect(() => darkArms('a\nx = dark ? (1', 'src/x.jsx')).toThrow('src/x.jsx:2')
  })
})

describe('the allowlist', () => {
  const results = [{ file: 'src/a.jsx', line: 4, cls: 'bg-black/60' }]

  it('covers a matching offence', () => {
    const al = [{ file: 'src/a.jsx', class: 'bg-black/60', reason: 'scrim' }]
    expect(applyAllowlist(results, al)).toEqual({ offences: [], stale: [] })
  })

  it('does not cover another class or file', () => {
    const al = [{ file: 'src/b.jsx', class: 'bg-black/60', reason: 'scrim' }]
    const r = applyAllowlist(results, al)
    expect(r.offences).toEqual(results)
    expect(r.stale).toEqual(al)
  })

  it('reports an entry that matches nothing as stale', () => {
    const al = [{ file: 'src/a.jsx', class: 'bg-black/80', reason: 'scrim' }]
    expect(applyAllowlist(results, al).stale).toEqual(al)
  })
})
