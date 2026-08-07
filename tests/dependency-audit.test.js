import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  advisoryId,
  collectAdvisories,
  validateAllowlist,
  classifyAdvisories,
} from '../scripts/audit-allowlist.mjs'

// Captured verbatim from `npm audit --omit=dev --audit-level=high --json`
// against the pre-fix lockfile (ip-address 10.2.0, reached via
// imapflow → socks). This is the exact payload that had the Dependency
// audit workflow red from 2026-08-04 to 2026-08-07, and it is the reason
// the severity split below matters: npm reports the PACKAGE as high
// while only ONE of its three `via` advisories is high.
const IP_ADDRESS_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'ip-address': {
      name: 'ip-address',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1130722,
          name: 'ip-address',
          dependency: 'ip-address',
          title:
            'ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass',
          url: 'https://github.com/advisories/GHSA-mwp4-54f8-5fhr',
          severity: 'high',
          range: '<=10.3.0',
        },
        {
          source: 1130723,
          name: 'ip-address',
          dependency: 'ip-address',
          title:
            'ip-address: a CIDR suffix on the parsed address suppresses special-use classification and can bypass SSRF and trust-boundary checks',
          url: 'https://github.com/advisories/GHSA-4xrf-jv44-h6hh',
          severity: 'moderate',
          range: '>=10.1.1 <=10.2.1',
        },
        {
          source: 1130724,
          name: 'ip-address',
          dependency: 'ip-address',
          title:
            'ip-address: misclassification of IPv4-mapped/NAT64 IPv6 addresses can bypass SSRF and trust-boundary checks',
          url: 'https://github.com/advisories/GHSA-22jq-vg5j-6vgg',
          severity: 'moderate',
          range: '>=10.1.1 <=10.2.0',
        },
      ],
      effects: [],
      range: '<=10.3.0',
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
}

const CLEAN_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
}

describe('advisoryId', () => {
  it('prefers the GHSA id from the advisory url', () => {
    expect(advisoryId({ url: 'https://github.com/advisories/GHSA-mwp4-54f8-5fhr', source: 1130722 })).toBe(
      'GHSA-mwp4-54f8-5fhr'
    )
  })

  it('falls back to the npm source id when there is no GHSA url', () => {
    expect(advisoryId({ source: 99 })).toBe('npm-99')
  })
})

describe('collectAdvisories', () => {
  it('gates only the high/critical via entries, not the whole package', () => {
    const { gated, informational } = collectAdvisories(IP_ADDRESS_REPORT)
    expect(gated.map((a) => a.id)).toEqual(['GHSA-mwp4-54f8-5fhr'])
    // The two moderates ride along on a package npm labels `high`. If
    // they were gated too, accepting the real high would still leave the
    // build red for advisories below the threshold.
    expect(informational.map((a) => a.id)).toEqual(['GHSA-4xrf-jv44-h6hh', 'GHSA-22jq-vg5j-6vgg'])
  })

  it('carries the package, range and url through for the failure message', () => {
    const { gated } = collectAdvisories(IP_ADDRESS_REPORT)
    expect(gated[0]).toMatchObject({
      package: 'ip-address',
      range: '<=10.3.0',
      url: 'https://github.com/advisories/GHSA-mwp4-54f8-5fhr',
    })
  })

  it('returns nothing for a clean report', () => {
    expect(collectAdvisories(CLEAN_REPORT)).toEqual({ gated: [], informational: [] })
  })

  it('ignores string `via` entries (transitive pointers, not advisories)', () => {
    const report = {
      vulnerabilities: {
        socks: { name: 'socks', severity: 'high', via: ['ip-address'] },
      },
    }
    expect(collectAdvisories(report).gated).toEqual([])
  })

  it('de-dupes an advisory reported under several dependents', () => {
    const via = {
      source: 1,
      name: 'ip-address',
      title: 'x',
      url: 'https://github.com/advisories/GHSA-mwp4-54f8-5fhr',
      severity: 'high',
    }
    const report = {
      vulnerabilities: {
        'ip-address': { name: 'ip-address', via: [via] },
        socks: { name: 'socks', via: [via] },
      },
    }
    expect(collectAdvisories(report).gated).toHaveLength(1)
  })

  it('survives a malformed report without throwing', () => {
    expect(collectAdvisories(null)).toEqual({ gated: [], informational: [] })
    expect(collectAdvisories({})).toEqual({ gated: [], informational: [] })
  })
})

describe('validateAllowlist', () => {
  const valid = { id: 'GHSA-mwp4-54f8-5fhr', package: 'ip-address', reason: 'because', expires: '2026-12-01' }

  it('accepts a well-formed entry', () => {
    expect(validateAllowlist([valid])).toEqual([])
  })

  it('rejects an entry with no expiry — that would be a permanent mute', () => {
    const { expires: _expires, ...noExpiry } = valid
    expect(validateAllowlist([noExpiry]).join()).toMatch(/missing "expires"/)
  })

  it.each(['reason', 'package', 'id'])('rejects an entry missing %s', (field) => {
    const entry = { ...valid }
    delete entry[field]
    expect(validateAllowlist([entry]).join()).toMatch(new RegExp(`missing "${field}"`))
  })

  it('rejects a non ISO expiry', () => {
    expect(validateAllowlist([{ ...valid, expires: '1 Dec 2026' }]).join()).toMatch(/want YYYY-MM-DD/)
  })

  it('treats an empty allowlist as valid', () => {
    expect(validateAllowlist([])).toEqual([])
    expect(validateAllowlist(undefined)).toEqual([])
  })
})

describe('classifyAdvisories', () => {
  const { gated } = collectAdvisories(IP_ADDRESS_REPORT)
  const entry = {
    id: 'GHSA-mwp4-54f8-5fhr',
    package: 'ip-address',
    reason: 'imapflow never configures a SOCKS proxy',
    expires: '2026-12-01',
  }

  it('fails an advisory that is not on the allowlist — the new-advisory signal', () => {
    const { unlisted, accepted, expired } = classifyAdvisories(gated, [], '2026-08-07')
    expect(unlisted.map((a) => a.id)).toEqual(['GHSA-mwp4-54f8-5fhr'])
    expect(accepted).toEqual([])
    expect(expired).toEqual([])
  })

  it('accepts an unexpired allowlisted advisory', () => {
    const { accepted, unlisted, expired } = classifyAdvisories(gated, [entry], '2026-08-07')
    expect(accepted.map((a) => a.id)).toEqual(['GHSA-mwp4-54f8-5fhr'])
    expect(accepted[0].entry.reason).toBe(entry.reason)
    expect(unlisted).toEqual([])
    expect(expired).toEqual([])
  })

  it('fails once the entry expires — entries cannot rot into a permanent mute', () => {
    const { expired, accepted } = classifyAdvisories(gated, [entry], '2026-12-02')
    expect(expired.map((a) => a.id)).toEqual(['GHSA-mwp4-54f8-5fhr'])
    expect(accepted).toEqual([])
  })

  it('still accepts on the expiry date itself (expiry is exclusive)', () => {
    const { accepted, expired } = classifyAdvisories(gated, [entry], '2026-12-01')
    expect(accepted).toHaveLength(1)
    expect(expired).toEqual([])
  })

  it('matches the GHSA id case-insensitively', () => {
    const { accepted } = classifyAdvisories(gated, [{ ...entry, id: 'ghsa-MWP4-54f8-5FHR' }], '2026-08-07')
    expect(accepted).toHaveLength(1)
  })

  it('reports an entry for a no-longer-present advisory as stale, without failing', () => {
    const { stale, unlisted, expired } = classifyAdvisories([], [entry], '2026-08-07')
    expect(stale.map((e) => e.id)).toEqual([entry.id])
    expect(unlisted).toEqual([])
    expect(expired).toEqual([])
  })

  it('is clean for the post-fix report — the state this PR ships', () => {
    const post = collectAdvisories(CLEAN_REPORT)
    const { unlisted, expired, accepted, stale } = classifyAdvisories(post.gated, [], '2026-08-07')
    expect([unlisted, expired, accepted, stale].every((a) => a.length === 0)).toBe(true)
  })
})

// DEPAUDIT.2 — the allowlist files that actually ship.
//
// check-dependency-audit.mjs validates whatever allowlist it is handed at
// runtime, so a malformed one fails the CI job rather than the test suite —
// and only on a dep-touching PR, since that is the workflow's `paths:`
// trigger. These read the real files off disk so a typo (missing expiry, bad
// date, id/package mix-up) fails locally on `npm test` instead.
//
// The mobile file arrived with DEPAUDIT.2, which turned on the mobile tree's
// audit for the first time. It carries the two linkify-it advisories that have
// NO published fix at any version (npm reports fixAvailable:false against a
// range of <=5.0.1), so an accept is the only option short of dropping
// markdown rendering from the contracts screen.
describe('the shipped allowlist files', () => {
  const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))

  for (const [label, path] of [
    ['web', '../.audit-allowlist.json'],
    ['mobile', '../mobile/.audit-allowlist.json'],
  ]) {
    it(`${label}: is valid JSON with a well-formed accepted[]`, () => {
      const file = load(path)
      expect(Array.isArray(file.accepted)).toBe(true)
      expect(validateAllowlist(file.accepted)).toEqual([])
    })

    it(`${label}: every entry has a real reason and an unexpired date`, () => {
      for (const entry of load(path).accepted) {
        // A generic "low risk" is explicitly not a reason — the readme asks
        // for the code path, so require something substantive.
        expect(entry.reason.length, `${entry.id} reason too thin`).toBeGreaterThan(60)
        // An entry shipped already-expired would fail CI the moment it lands.
        expect(
          new Date(entry.expires).getTime(),
          `${entry.id} expires in the past`,
        ).toBeGreaterThan(new Date('2026-08-07').getTime())
      }
    })
  }

  it('mobile accepts exactly the two unfixable linkify-it advisories', () => {
    const ids = load('../mobile/.audit-allowlist.json').accepted.map((e) => e.id).sort()
    expect(ids).toEqual(['GHSA-22p9-wv53-3rq4', 'GHSA-v245-v573-v5vm'])
  })

  it('web accepts nothing — empty is the healthy state', () => {
    expect(load('../.audit-allowlist.json').accepted).toEqual([])
  })
})
