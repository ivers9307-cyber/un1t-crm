// GAPS-P7 — the source registry. These tests pin the thing that broke:
// a `consent_log` opt_out row is not automatically a departure, and summing
// the column blind turned a one-day data migration into a 5,536-person list
// collapse in May 2026.
//
// The live vocabulary below is the fixture. If a new source appears in the
// column and nobody maps it, `categoriseConsentSource` must answer 'unknown'
// and the surface must show it, rather than the source quietly joining churn.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  CONSENT_SOURCE_CATEGORIES,
  CONSENT_SOURCE_CATEGORY,
  NET_LIST_CHANGE_CATEGORIES,
  categoriseConsentSource,
  sourcesInCategory,
  countsTowardNetListChange,
  consentSourceRpcArgs,
} from './consent-sources.js'

// Every source live in consent_log for channel email_marketing since
// 2026-05-01, with its row count, as measured 2026-08-10.
const LIVE_VOCABULARY = [
  ['bulk_import', 3963, 'bulk'],
  ['auto_classpass_backfill', 1533, 'bulk'],
  ['unsub_click_recovery', 160, 'bulk'],
  ['auto_classpass', 82, 'policy'],
  ['duplicate_propagation', 0, 'policy'],
  ['postmark_one_click_unsubscribe', 56, 'voluntary'],
  ['event_form', 38, 'voluntary'],
  ['one_click_unsubscribe', 27, 'voluntary'],
  ['postmark_suppression_backfill', 23, 'bulk'],
  ['postmark_hard_bounce', 18, 'deliverability'],
  ['admin_panel', 4, 'voluntary'],
  ['booking_form', 2, 'voluntary'],
  ['leadcap1_scope_correction', 2, 'bulk'],
  ['postmark_spam_complaint', 1, 'deliverability'],
]

describe('the live vocabulary is completely mapped', () => {
  it.each(LIVE_VOCABULARY)('%s is categorised as %s', (source, _rows, category) => {
    expect(categoriseConsentSource(source)).toBe(category)
  })

  it('leaves nothing in the live column unclassified', () => {
    const unmapped = LIVE_VOCABULARY
      .map(([source]) => source)
      .filter((s) => categoriseConsentSource(s) === 'unknown')
    expect(unmapped).toEqual([])
  })

  it('excludes the 5,681 bulk rows from the headline', () => {
    // 3,963 + 1,533 + 23 on 2026-05-13, 2 corrections on 2026-08-06, and the
    // 160 opt-outs mig 545 reconstructed from click evidence on 2026-08-14.
    // That last set records departures that already happened months earlier,
    // so counting them as fresh churn would misreport the month they land in.
    const bulkRows = LIVE_VOCABULARY
      .filter(([, , c]) => c === 'bulk')
      .reduce((t, [, rows]) => t + rows, 0)
    expect(bulkRows).toBe(5681)
    for (const [source] of LIVE_VOCABULARY.filter(([, , c]) => c === 'bulk')) {
      expect(countsTowardNetListChange(source)).toBe(false)
    }
  })

  it('counts 146 real departures across the window, not 5,909', () => {
    const counted = LIVE_VOCABULARY
      .filter(([source]) => countsTowardNetListChange(source))
      .reduce((t, [, rows]) => t + rows, 0)
    expect(counted).toBe(146)
    const all = LIVE_VOCABULARY.reduce((t, [, rows]) => t + rows, 0)
    expect(all).toBe(5909)
  })
})

describe('what moves the net', () => {
  it('is voluntary and deliverability, and only those', () => {
    expect([...NET_LIST_CHANGE_CATEGORIES].sort()).toEqual(['deliverability', 'voluntary'])
  })

  it('keeps the ClassPass standing rule out of the headline', () => {
    // A membership transition, one-way, written unconditionally rather than on
    // a flip. It is shown on the page in its own column, not netted.
    expect(categoriseConsentSource('auto_classpass')).toBe('policy')
    expect(countsTowardNetListChange('auto_classpass')).toBe(false)
  })

  it('counts a permanent bounce and a spam report as real lost reach', () => {
    expect(countsTowardNetListChange('postmark_hard_bounce')).toBe(true)
    expect(countsTowardNetListChange('postmark_spam_complaint')).toBe(true)
  })
})

describe('an unmapped source', () => {
  it('answers unknown rather than falling into a category', () => {
    expect(categoriseConsentSource('some_future_import_2027')).toBe('unknown')
    expect(countsTowardNetListChange('some_future_import_2027')).toBe(false)
  })

  it('answers unknown for a null, a number or an empty string', () => {
    for (const bad of [null, undefined, 42, '', {}]) {
      expect(categoriseConsentSource(bad)).toBe(CONSENT_SOURCE_CATEGORIES.UNKNOWN)
    }
  })

  it('is never included in any category array, so the RPC sees it as unknown', () => {
    const everyListed = Object.values(consentSourceRpcArgs()).flat()
    expect(everyListed).not.toContain('some_future_import_2027')
    // The arrays together are exactly the registry, with nothing dropped.
    expect(everyListed.slice().sort()).toEqual(Object.keys(CONSENT_SOURCE_CATEGORY).sort())
  })

  it('tolerates casing and padding rather than inventing a second unknown', () => {
    expect(categoriseConsentSource('  BULK_IMPORT ')).toBe('bulk')
  })
})

describe('the RPC arguments', () => {
  it('name every parameter the function takes', () => {
    expect(Object.keys(consentSourceRpcArgs()).sort()).toEqual([
      'p_bulk_sources', 'p_deliverability_sources', 'p_policy_sources', 'p_voluntary_sources',
    ])
  })

  it('are sorted, so the same call produces the same argument', () => {
    const bulk = sourcesInCategory('bulk')
    expect(bulk).toEqual([...bulk].sort())
  })

  it('put each source in exactly one array', () => {
    const all = Object.values(consentSourceRpcArgs()).flat()
    expect(new Set(all).size).toBe(all.length)
  })
})

// ── Source scan: a new writer cannot introduce an unmapped source ────
//
// Same idiom as the consent-actions writer scan (GAPS-P6), and the same
// honesty about its reach: this is a FLOOR, not proof. It finds a `source:`
// literal sitting near a consent write in the same file, which today catches
// 12 of the live sources. It does not see a source assembled into a variable,
// passed down from a caller, or written by a Postgres trigger
// (`auto_classpass` is invisible to any source scan). The live-vocabulary
// fixture above is what covers those; this catches the common case, where
// somebody adds a form or an import next to an existing one.

const SRC = path.join(process.cwd(), 'src')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx)$/.test(entry) && !/\.test\.(js|jsx)$/.test(entry)) out.push(full)
  }
  return out
}

// A `source: '<literal>'` sitting within ~700 characters after something that
// writes consent. The \b before `source` keeps `lead_source:` and `utm_source:`
// out, since `_` is a word character.
//
// HOST-CONSENT.1 — revokeHostConsent/grantHostConsent[Bulk]/resubscribeHost
// (src/lib/host-consent.js) are consent_log writers one call removed: a
// caller passes `source:` straight through to them, so a caller file never
// mentions `consent_log` itself and was invisible to this scan.
const CONSENT_CONTEXT = /(?:consent_log|applyMarketingPreferences(?:Bulk)?|applyFormMarketingConsent|revokeHostConsent|grantHostConsent(?:Bulk)?|resubscribeHost)[\s\S]{0,700}/g
const SOURCE_LITERAL = /\bsource:\s*['"]([a-z0-9_]+)['"]/g

function consentSourceLiterals() {
  const found = new Set()
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const context of src.matchAll(CONSENT_CONTEXT)) {
      for (const hit of context[0].matchAll(SOURCE_LITERAL)) found.add(hit[1])
    }
  }
  return [...found].sort()
}

describe('consent sources written beside a consent write in src/', () => {
  it('finds writers at all (the scan is not silently matching nothing)', () => {
    // 12 today. If this drops the scan has stopped seeing the writers, which
    // would turn the assertion below into a green no-op.
    expect(consentSourceLiterals().length).toBeGreaterThanOrEqual(10)
  })

  it('maps all of them', () => {
    const unmapped = consentSourceLiterals().filter((s) => categoriseConsentSource(s) === 'unknown')
    expect(unmapped).toEqual([])
  })
})

// ── The consent_log INSERT scan (GAPS-P7.2) ──────────────────────────
//
// `consent_log.source` is unconstrained free text, the same drift class that
// `action` carried until GAPS-P6. It is deliberately NOT getting a DB CHECK
// constraint: `action` has exactly two legal values forever, whereas a source
// is the name of a capture point and new ones legitimately ship with new
// forms, imports and webhooks. A constraint there would turn "we added a
// signup form" into "the insert 500s in production".
//
// So the enforcement is a machine test instead, in the GAPS-P6 idiom but
// keyed on the WRITER rather than on a proximity window: find every file that
// actually inserts into consent_log, and require every `source:` literal in
// it to be a registered source. Missing a registry entry then fails in CI,
// where it is free, instead of landing in the column and quietly reading as
// 'unknown' on the list-health page months later.
//
// This complements, rather than replaces, the proximity scan above: that one
// also covers the applyMarketingPreferences* helpers, which are not
// consent_log writers themselves.

// HOST-CONSENT.1 — a file that calls revokeHostConsent/grantHostConsent[Bulk]/
// resubscribeHost never touches `consent_log` itself (host-consent.js does,
// one call away), so it was invisible to the `.from('consent_log')` pattern
// below. Widened rather than replaced: both patterns are real writers.
const DIRECT_CONSENT_LOG_INSERT = /\.from\(\s*['"]consent_log['"]\s*\)[\s\S]{0,400}?\.(insert|upsert)\(/
const HOST_CONSENT_CALL = /\b(?:revokeHostConsent|grantHostConsentBulk|grantHostConsent|resubscribeHost)\(/
const CONSENT_LOG_WRITERS = walk(SRC).filter((f) => {
  const content = readFileSync(f, 'utf8')
  return DIRECT_CONSENT_LOG_INSERT.test(content) || HOST_CONSENT_CALL.test(content)
})

// A direct writer is scanned whole-file, as before (unchanged behaviour for
// the pre-existing 6). A host-helper CALLER is scanned only inside that
// call's own argument list — not the whole file — because a caller can
// legitimately carry an unrelated `source:` field nothing to do with consent
// (host-contact-list.js tags a host_contacts row `source: 'event'`; a
// whole-file scan there would misread it as an unregistered consent source).
const FULL_FILE_SOURCE_LITERAL = /\bsource:\s*['"]([a-zA-Z0-9_]+)['"]/g
const HOST_CONSENT_CALL_SOURCE = /\b(?:revokeHostConsent|grantHostConsentBulk|grantHostConsent|resubscribeHost)\([\s\S]{0,300}?\bsource:\s*['"]([a-zA-Z0-9_]+)['"]/g

describe('every consent_log insert in src/ writes a registered source', () => {
  it('finds the writers (the scan is not silently matching nothing)', () => {
    // 13 today (6 direct consent_log inserts, plus 7 files reaching it one
    // call away through a host-consent.js helper). A refactor may
    // legitimately move writes behind a helper and shrink this, but it must
    // never reach zero unnoticed — that would turn the assertion below into
    // a green no-op, which is the failure mode this whole file exists to
    // prevent.
    expect(CONSENT_LOG_WRITERS.length).toBeGreaterThan(0)
  })

  it.each(CONSENT_LOG_WRITERS.map((f) => [path.relative(SRC, f), f]))(
    '%s names only registered sources',
    (_rel, file) => {
      const content = readFileSync(file, 'utf8')
      const literals = DIRECT_CONSENT_LOG_INSERT.test(content)
        ? [...content.matchAll(FULL_FILE_SOURCE_LITERAL)].map((m) => m[1])
        : [...content.matchAll(HOST_CONSENT_CALL_SOURCE)].map((m) => m[1])
      const unmapped = [...new Set(literals)].filter((s) => categoriseConsentSource(s) === 'unknown')
      expect(unmapped).toEqual([])
    },
  )
})

// ── The operator-facing label map ────────────────────────────────────
//
// ContactConsentHistoryCard renders the consent history a compliance officer
// reads. Its SOURCE_LABELS map had an entry for `unsubscribe_one_click`, a
// transposition of the real `one_click_unsubscribe` that nothing has ever
// written. A label for a source that cannot occur is dead weight that reads
// as evidence the value exists; worse, the same typo sat in CUSTOMER_SOURCES,
// so anyone copying from there would have written the wrong slug.

describe('the contact consent-history label map', () => {
  const CARD = path.join(process.cwd(), 'src', 'components', 'ContactConsentHistoryCard.jsx')

  it('labels only sources that are in the registry', () => {
    const src = readFileSync(CARD, 'utf8')
    const block = src.slice(src.indexOf('const SOURCE_LABELS'), src.indexOf('const CHANNEL_LABELS'))
    const keys = [...block.matchAll(/^\s{2}([a-z0-9_]+):\s*\{/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(10)
    const unregistered = keys.filter((k) => categoriseConsentSource(k) === 'unknown')
    expect(unregistered).toEqual([])
  })

  it('lists only registered sources as customer-driven', () => {
    const src = readFileSync(CARD, 'utf8')
    const block = src.slice(src.indexOf('const CUSTOMER_SOURCES'), src.indexOf('function fmtSource'))
    const keys = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(5)
    const unregistered = keys.filter((k) => categoriseConsentSource(k) === 'unknown')
    expect(unregistered).toEqual([])
  })
})
