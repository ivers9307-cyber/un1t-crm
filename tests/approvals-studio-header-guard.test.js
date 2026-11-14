// APPROVALSQ.6 — every request a card sends about an item must name the item's
// studio (x-active-location), or the route judges it at the wrong studio. The
// one place that builds the header is src/lib/approvals/studio-request.js; this
// guard fails, naming file and line, on any fetch( in the approvals card files
// whose arguments do not go through withStudio( or studioHeaders(.
//
// Blind spot: a fetch passed through a variable (const f = fetch) is invisible.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')

// Every non-test source file in a directory (not recursive).
const sourcesIn = (dir) => readdirSync(join(ROOT, dir))
  .filter((f) => /\.(jsx?|mjs)$/.test(f) && !/\.test\./.test(f))
  .map((f) => `${dir}/${f}`)

// The components ApprovalsInbox.jsx imports (the cards), read from its import
// lines, so a card added to the page later is scanned without touching this test.
function importedComponents(file) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const out = []
  for (const m of src.matchAll(/^import\s[^'"]*from\s+'@\/(components\/[^']+)'/gm)) {
    const base = `src/${m[1]}`
    const found = ['.jsx', '.js', '/index.jsx', '/index.js'].map((e) => base + e).find((f) => { try { readFileSync(join(ROOT, f)); return true } catch { return false } })
    if (found) out.push(found)
  }
  return out
}

const FILES = [...new Set([
  ...sourcesIn('src/components/approvals'),
  ...sourcesIn('src/lib/approvals'),
  ...importedComponents('src/components/ApprovalsInbox.jsx'),
  'src/components/ApprovalsInbox.jsx',
])]

// A fetch that is not about an item. Keyed `file:snippet`; the reason is the value.
export const EXEMPT = {
  "src/components/ApprovalsInbox.jsx:fetch(pendingUrl": 'the pending-list load itself: it is about the person, not an item',
}

// The text of the call: from `fetch(` to its matching close paren.
function callText(src, start) {
  let depth = 0
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

export function findViolations(file, src) {
  const out = []
  // fetch(, window.fetch( and globalThis.fetch( (a `.fetch(` on anything else is not ours).
  const re = /(^|[^\w.$])((?:window\.|globalThis\.)?fetch)\(/g
  let m
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length
    const text = callText(src, start)
    if (/withStudio\(|studioHeaders\(/.test(text)) continue
    const line = src.slice(0, start).split('\n').length
    const snippet = text.replace(/\s+/g, ' ').slice(0, 40)
    if (Object.keys(EXEMPT).some((k) => k.startsWith(`${file}:`) && snippet.startsWith(k.slice(file.length + 1)))) continue
    out.push(`${file}:${line}  ${snippet}`)
  }
  return out
}

describe('approvals cards name the item studio on every request', () => {
  it('scans the files it means to', () => {
    expect(FILES).toContain('src/components/approvals/BulkClearBar.jsx')
    expect(FILES).toContain('src/components/approvals/OfferPurchaseCard.jsx')
    // Every non-test file in the two directories, and the cards the page imports.
    expect(FILES).toContain('src/lib/approvals/team-actions.js')
    expect(FILES).toContain('src/lib/approvals/studio-request.js')
    expect(FILES).toContain('src/components/AgentRequestDecideCard.jsx')
    expect(FILES).toContain('src/components/TrialPurchaseReviewCard.jsx')
    expect(FILES).toContain('src/components/CorpPromoClaimCard.jsx')
    expect(FILES).toContain('src/components/ApprovalsInbox.jsx')
    expect(FILES.some((f) => /\.test\./.test(f))).toBe(false)
    expect(FILES.every((f) => { try { readFileSync(join(ROOT, f)); return true } catch { return false } })).toBe(true)
  })

  it('has no fetch( without withStudio( or studioHeaders(', () => {
    const bad = FILES.flatMap((f) => findViolations(f, readFileSync(join(ROOT, f), 'utf8')))
    expect(bad, `fetch without the studio header:\n${bad.join('\n')}`).toEqual([])
  })

  it('would fail on a call that lost the helper', () => {
    const src = "async function a(item) {\n  return fetch(`/api/x/${item.id}`, { method: 'POST' })\n}\n"
    expect(findViolations('src/components/approvals/X.jsx', src)).toHaveLength(1)
    const ok = "async function a(item) {\n  return fetch(`/api/x/${item.id}`, withStudio(item, { method: 'POST' }))\n}\n"
    expect(findViolations('src/components/approvals/X.jsx', ok)).toEqual([])
  })

  it('also sees window.fetch( and globalThis.fetch(', () => {
    const w = "const a = () => window.fetch('/api/x', { method: 'POST' })\n"
    const g = "const a = () => globalThis.fetch('/api/x', { method: 'POST' })\n"
    expect(findViolations('src/components/approvals/X.jsx', w)).toHaveLength(1)
    expect(findViolations('src/components/approvals/X.jsx', g)).toHaveLength(1)
    expect(findViolations('src/components/approvals/X.jsx', "window.fetch('/x', withStudio(item, {}))")).toEqual([])
    // Not a global fetch: some other object's .fetch( is left alone.
    expect(findViolations('src/components/approvals/X.jsx', "client.fetch('/x')")).toEqual([])
  })
})
