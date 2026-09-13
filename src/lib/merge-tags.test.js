// K3 — the drift guard.
//
// The operator-facing merge-tag lists drifted from applyMergeTags() because
// nothing tied them together: three hand-copied arrays in two editors, plus a
// docblock, all describing the same substitution table by hand. This test is
// the tie. It checks both directions, because both have already happened:
//
//   • applyMergeTags substitutes a tag the registry does not list
//     → operators cannot discover it (the original defect: 5 such tags).
//   • the registry lists a tag applyMergeTags does not substitute
//     → the editor offers a tag that renders as literal {{...}} in a real
//       email, which is worse than not offering it.
//
// A unit test on the constants alone would not catch either, so this reads the
// substitution table out of postmark.js's source AND exercises the function.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { applyMergeTags } from './postmark.js'
import {
  MERGE_TAGS,
  OFFERED_MERGE_TAGS,
  UNLAYER_MERGE_TAGS,
  MERGE_TAG_REFERENCE,
} from './merge-tags.js'

const SRC = path.resolve(process.cwd(), 'src')
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8')

// The `replacements` object literal inside applyMergeTags — the real table.
function tagsInApplyMergeTags() {
  const source = read('lib/postmark.js')
  const start = source.indexOf('export function applyMergeTags')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n}', start))
  return [...body.matchAll(/'(\{\{[a-z0-9_]+\}\})'\s*:/g)].map((m) => m[1])
}

describe('the registry and applyMergeTags() agree', () => {
  it('lists every tag applyMergeTags substitutes — no undiscoverable tags', () => {
    const substituted = tagsInApplyMergeTags()
    const registered = MERGE_TAGS.map((t) => t.tag)
    expect([...substituted].sort()).toEqual([...registered].sort())
  })

  it('every registered tag really is substituted, not left as literal text', () => {
    const contact = {
      first_name: 'Ann', last_name: 'Byrne', name: 'Ann Byrne',
      email: 'ann@example.com', phone: '+353871234567',
      pipeline_stage_slug: 'trial_booked', glofox_passcode: '4821',
    }
    const extras = {
      location_name: 'UN1T Stillorgan',
      unsubscribe_url: 'https://example.com/unsubscribe/tok',
      preference_url: 'https://example.com/preferences/tok',
      booking_token: 'cGF5bG9hZA.c2ln',
      // PAYLINK.7 — only non-empty on an overdue-payment reminder run.
      pay_amount_phrase: ' of €209',
      payment_cta: '<a href="https://pay.test/x">pay it now here</a>',
    }
    for (const { tag } of MERGE_TAGS) {
      const out = applyMergeTags(`<p>${tag}</p>`, contact, extras)
      expect(out, `${tag} was not substituted`).not.toContain(tag)
      expect(out, `${tag} substituted to an empty string`).not.toBe('<p></p>')
    }
  })
})

describe('the registry is well formed', () => {
  it('has no duplicate tags', () => {
    const tags = MERGE_TAGS.map((t) => t.tag)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('states a reason for every tag it withholds from operators', () => {
    for (const t of MERGE_TAGS.filter((x) => !x.offered)) {
      expect(t.why, `${t.tag} is withheld with no reason`).toBeTruthy()
    }
  })

  it('withholds exactly the deprecated alias, the welcome-sequence tag, and the payment-reminder tags', () => {
    // Pinned so widening the withheld set is a deliberate edit to this test,
    // not a quiet way to stop advertising something that works.
    expect(MERGE_TAGS.filter((t) => !t.offered).map((t) => t.tag).sort())
      .toEqual(['{{glofox_passcode}}', '{{lead_status}}', '{{pay_amount_phrase}}', '{{payment_cta}}'])
  })

  it('derives the editor shapes from the offered set', () => {
    expect(UNLAYER_MERGE_TAGS).toHaveLength(OFFERED_MERGE_TAGS.length)
    expect(MERGE_TAG_REFERENCE).toHaveLength(OFFERED_MERGE_TAGS.length)
    expect(UNLAYER_MERGE_TAGS[0]).toEqual({ name: 'First Name', value: '{{first_name}}' })
    expect(MERGE_TAG_REFERENCE[0]).toEqual(['{{first_name}}', "Contact's first name"])
  })
})

// The editors must RENDER the registry, not re-copy it. Re-hardcoding a list
// is exactly how the three copies drifted apart in the first place, and a
// registry nobody reads guards nothing.
describe('the editors render the registry rather than their own copy', () => {
  const EDITORS = ['components/CampaignEditor.jsx', 'components/TemplateEditor.jsx']

  it.each(EDITORS)('%s imports from lib/merge-tags', (rel) => {
    expect(read(rel)).toMatch(/from ['"]@\/lib\/merge-tags['"]/)
  })

  it.each(EDITORS)('%s declares no merge-tag list of its own', (rel) => {
    const source = read(rel)
    // An Unlayer entry (`value: '{{x}}'`) or a reference-panel pair
    // (`['{{x}}', '…']`) written by hand.
    expect(source).not.toMatch(/value:\s*'\{\{/)
    expect(source).not.toMatch(/\[\s*'\{\{[a-z0-9_]+\}\}'\s*,/)
  })
})

// The EDITORS list above only checked the two files known to have drifted
// before. useUnlayerEditor.js drifted the SAME way (its own `value: '{{x}}'`
// array, already missing {{booking_token}}) without anyone adding it to that
// list — the guard has to find new copies on its own, not wait to be told
// where to look. So this walks every non-test file under src/components and
// fails on any hard-coded Unlayer-style merge-tag entry it doesn't already
// know about.
describe('no other hard-coded merge-tag arrays lurk in src/components', () => {
  // HostEmails.jsx (HOST-EMAIL.6) hard-codes its OWN, narrower list on
  // purpose: the host-send path substitutes only these four tags, not the
  // full contact registry (hosts have no pipeline_stage, phone, etc.). Using
  // UNLAYER_MERGE_TAGS there would offer tags that render as literal
  // {{...}} in a host email. A documented exception, not an oversight —
  // widening this set is a deliberate edit to this list, not a quiet way to
  // let a real copy back in.
  const ALLOWED_OWN_LIST = new Set(['components/host/HostEmails.jsx'])

  function jsFilesUnder(rel) {
    const files = []
    for (const entry of readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
      const relPath = path.join(rel, entry.name)
      if (entry.isDirectory()) { files.push(...jsFilesUnder(relPath)); continue }
      if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) files.push(relPath)
    }
    return files
  }

  it.each(jsFilesUnder('components').filter((rel) => !ALLOWED_OWN_LIST.has(rel)))(
    '%s has no hard-coded Unlayer merge-tag entry',
    (rel) => {
      const source = read(rel)
      expect(source).not.toMatch(/value:\s*'\{\{[a-z0-9_]+\}\}'/)
    },
  )
})
