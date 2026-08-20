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
import { readFileSync } from 'node:fs'
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

  it('withholds exactly the deprecated alias and the welcome-sequence tag', () => {
    // Pinned so widening the withheld set is a deliberate edit to this test,
    // not a quiet way to stop advertising something that works.
    expect(MERGE_TAGS.filter((t) => !t.offered).map((t) => t.tag).sort())
      .toEqual(['{{glofox_passcode}}', '{{lead_status}}'])
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
