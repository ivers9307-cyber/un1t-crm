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

const FILES = [
  ...readdirSync(join(ROOT, 'src/components/approvals'))
    .filter((f) => /\.(jsx?|mjs)$/.test(f) && !/\.test\./.test(f))
    .map((f) => `src/components/approvals/${f}`),
  'src/components/AgentRequestDecideCard.jsx',
  'src/components/TrialPurchaseReviewCard.jsx',
  'src/components/CorpPromoClaimCard.jsx',
  'src/components/ApprovalsInbox.jsx',
  'src/lib/approvals/team-actions.js',
  'src/lib/approvals/bulk-clear.js',
  'src/lib/approvals/undo-clear-request.js',
]

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
  const re = /(^|[^\w.$])fetch\(/g
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
})
