import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SAAS4-W0.2 — the four public legal pages must name ONE legal entity.
// Before 2026-07-19 they named two ("UN1T Dublin Ltd" on /privacy,
// /privacy/authority-requests and /terms vs "Champ Fitness Ltd" on
// /privacy/members) — flagged in the SaaS audit and in the member
// page's own source comment. Richard settled the entity on
// 2026-07-19: Champ Fitness Ltd (trading as UN1T Dublin) everywhere.
// This test reads the page sources so a future copy edit can't
// quietly reintroduce the split.

const PAGES = [
  'src/app/privacy/page.js',
  'src/app/privacy/members/page.js',
  'src/app/privacy/authority-requests/page.js',
  'src/app/terms/page.js',
]

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8')

describe('legal pages name a single legal entity', () => {
  for (const page of PAGES) {
    it(`${page} names Champ Fitness Ltd and never UN1T Dublin Ltd`, () => {
      const src = read(page)
      expect(src, `${page} must name the settled entity`).toContain('Champ Fitness Ltd')
      expect(src, `${page} still names the retired entity`).not.toContain('UN1T Dublin Ltd')
    })
  }
})

describe('staff privacy page subprocessor facts', () => {
  it('attributes WhatsApp delivery to Meta, not Twilio', () => {
    const src = read('src/app/privacy/page.js')
    // Twilio is SMS-only in this stack; WhatsApp goes through the Meta
    // Cloud API (src/lib/whatsapp.js). The pre-2026-07-19 copy claimed
    // "Twilio — SMS and WhatsApp message delivery".
    expect(src).not.toMatch(/Twilio<\/strong>[^<]*WhatsApp/i)
    expect(src).toContain('Meta')
  })

  it('lists the subprocessors the CRM actually uses for contact data', () => {
    const src = read('src/app/privacy/page.js')
    for (const vendor of ['Stripe', 'Upstash', 'Glofox']) {
      expect(src, `staff privacy page must list ${vendor}`).toContain(vendor)
    }
  })
})
