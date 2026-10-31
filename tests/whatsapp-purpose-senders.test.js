// WAORGNUMBER.2 (R5) — the senders that used to hard-code a template name
// name a PURPOSE instead, so the studio's own template is the one that goes
// out. A source pin for the callers that have no route-level test (a floor,
// not a proof: the resolver and each helper have their own tests).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const CALLERS = [
  ['src/lib/class-booking-processor.js', "purpose: 'class_confirmed'"],
  ['src/app/api/agent/membership-requests/[id]/route.js', "purpose: 'class_confirmed'"],
  ['src/app/api/public/book/route.js', "purpose: 'consult_confirmed'"],
  ['src/lib/event-waitlist.js', "purpose: 'event_waitlist_offer'"],
  // PAGES.1 PR3 removed the leads route's Meta-ad WhatsApp welcome (and
  // LEAD_CAMPAIGNS): a campaign is a page of its own, so that row is gone.
]

describe('automatic WhatsApp senders name a purpose (uses the studio\'s purpose template)', () => {
  it.each(CALLERS)('%s passes %s', (file, needle) => {
    expect(read(file)).toContain(needle)
  })

  it('none of them passes a hard-coded template name any more', () => {
    for (const [file] of CALLERS) {
      const src = read(file)
      expect(src, file).not.toMatch(/templateName:\s*(CLASS_CONFIRM_TEMPLATE|WAITLIST_OFFER_TEMPLATE|'booking_(class|consult)_confirmed_?')/)
    }
  })
})
