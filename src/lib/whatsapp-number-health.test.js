import { describe, it, expect } from 'vitest'
import {
  qualityDowngraded, tierDowngraded, tierLabel, healthDowngradeReason,
  pollQualityPauseReason, isMetaAuthError, tokenTransition,
  tokenInvalidNotification, tokenRecoveredNotification, fetchNumberHealth,
  normalizeMessagingLimit, isKnownTier, fetchMessagingLimit, MESSAGING_LIMIT_FIELD,
} from './whatsapp-number-health.js'

describe('qualityDowngraded', () => {
  it('true only when quality strictly worsens (GREEN>YELLOW>RED)', () => {
    expect(qualityDowngraded('GREEN', 'YELLOW')).toBe(true)
    expect(qualityDowngraded('YELLOW', 'RED')).toBe(true)
    expect(qualityDowngraded('GREEN', 'RED')).toBe(true)
  })
  it('false for same / improving / unknown', () => {
    expect(qualityDowngraded('GREEN', 'GREEN')).toBe(false)
    expect(qualityDowngraded('RED', 'GREEN')).toBe(false)       // recovery, not a drop
    expect(qualityDowngraded(null, 'RED')).toBe(false)          // first seed isn't a drop
    expect(qualityDowngraded('GREEN', 'UNKNOWN')).toBe(false)   // unranked → don't alert
    expect(qualityDowngraded(undefined, undefined)).toBe(false)
  })
})

describe('tierDowngraded', () => {
  it('true when the messaging tier drops', () => {
    expect(tierDowngraded('TIER_10K', 'TIER_1K')).toBe(true)
    expect(tierDowngraded('UNLIMITED', 'TIER_100K')).toBe(true)
  })
  it('false for same / upgrade / unknown', () => {
    expect(tierDowngraded('TIER_1K', 'TIER_1K')).toBe(false)
    expect(tierDowngraded('TIER_1K', 'TIER_10K')).toBe(false)
    expect(tierDowngraded(null, 'TIER_1K')).toBe(false)
  })
})

describe('tierLabel', () => {
  it('maps Meta tiers to operator-facing daily limits', () => {
    expect(tierLabel('TIER_1K')).toBe('1,000 / day')
    expect(tierLabel('UNLIMITED')).toBe('Unlimited')
    expect(tierLabel(null)).toBe('—')
  })
})

describe('healthDowngradeReason', () => {
  it('reports a quality drop', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
      { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_1K' },
    )).toBe('quality dropped GREEN → YELLOW')
  })
  it('reports a tier downgrade when quality is unchanged', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_10K' },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe('messaging limit lowered 10,000 / day → 1,000 / day')
  })
  it('returns null when nothing worsened (incl. first seed from null)', () => {
    expect(healthDowngradeReason(
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe(null)
    expect(healthDowngradeReason(
      { quality_rating: null, messaging_limit_tier: null },
      { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' },
    )).toBe(null)
  })
})

// ── WA-QUALITY.5 — poll-sourced quality collapse (batch 2026-07-10) ──────────

describe('pollQualityPauseReason', () => {
  it('pauses on a transition INTO RED / FLAGGED', () => {
    expect(pollQualityPauseReason('GREEN', 'RED')).toMatch(/RED/)
    expect(pollQualityPauseReason('YELLOW', 'RED')).toMatch(/RED/)
    expect(pollQualityPauseReason('GREEN', 'FLAGGED')).toMatch(/FLAGGED/)
  })
  it('a first-seed RED (never polled before) still pauses — RED is RED', () => {
    expect(pollQualityPauseReason(null, 'RED')).toMatch(/RED/)
    expect(pollQualityPauseReason(undefined, 'RED')).toMatch(/RED/)
  })
  it('no re-pause while already collapsed, and never on healthy ratings', () => {
    expect(pollQualityPauseReason('RED', 'RED')).toBeNull()
    expect(pollQualityPauseReason('FLAGGED', 'RED')).toBeNull()
    expect(pollQualityPauseReason('RED', 'GREEN')).toBeNull()   // recovery
    expect(pollQualityPauseReason('GREEN', 'YELLOW')).toBeNull() // downgrade ≠ collapse
    expect(pollQualityPauseReason('GREEN', 'GREEN')).toBeNull()
    expect(pollQualityPauseReason('GREEN', null)).toBeNull()
  })
})

// ── WA-TOKEN.1 — token-death classification + transition alerts ─────────────

describe('isMetaAuthError', () => {
  it('matches Meta error code 190 (number or string) and OAuthException', () => {
    expect(isMetaAuthError({ metaCode: 190 })).toBe(true)
    expect(isMetaAuthError({ metaCode: '190' })).toBe(true)
    expect(isMetaAuthError({ metaType: 'OAuthException' })).toBe(true)
  })
  it('other Meta errors and plain failures are not auth errors', () => {
    expect(isMetaAuthError({ metaCode: 100, metaType: 'GraphMethodException' })).toBe(false)
    expect(isMetaAuthError(new Error('fetch failed'))).toBe(false)
    expect(isMetaAuthError(null)).toBe(false)
  })
})

describe('tokenTransition', () => {
  it('null stamp + auth error = invalidated (first detection)', () => {
    expect(tokenTransition(null, true)).toBe('invalidated')
  })
  it('existing stamp + auth error = no transition (no re-page every poll tick)', () => {
    expect(tokenTransition('2026-07-10T09:00:00Z', true)).toBeNull()
  })
  it('existing stamp + healthy fetch = recovered', () => {
    expect(tokenTransition('2026-07-10T09:00:00Z', false)).toBe('recovered')
  })
  it('no stamp + healthy fetch = steady state', () => {
    expect(tokenTransition(null, false)).toBeNull()
  })
})

describe('token notifications', () => {
  it('invalid-token page names the number and demands a permanent System User token', () => {
    const n = tokenInvalidNotification('UN1T Stillorgan')
    expect(n.title).toMatch(/token/i)
    expect(n.body).toContain('UN1T Stillorgan')
    expect(n.body).toMatch(/System User token/i)
  })
  it('recovery notification is calm and names the number', () => {
    const n = tokenRecoveredNotification('UN1T Stillorgan')
    expect(n.title).toMatch(/recovered/i)
    expect(n.body).toContain('UN1T Stillorgan')
  })
})

describe('fetchNumberHealth — Meta error metadata', () => {
  it('attaches metaCode/metaType so the poll can classify token deaths', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      json: async () => ({ error: { message: 'Error validating access token', code: 190, type: 'OAuthException' } }),
    })
    try {
      await expect(fetchNumberHealth({ phoneNumberId: 'p1', token: 't' })).rejects.toMatchObject({
        message: 'Error validating access token',
        metaCode: 190,
        metaType: 'OAuthException',
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// WA-LIMIT.1 — Meta deprecated `messaging_limit_tier` on the phone-number node
// and stopped returning it; the limit now comes from
// `whatsapp_business_manager_messaging_limit`.
describe('normalizeMessagingLimit', () => {
  it('stores one spelling for every form Meta sends', () => {
    expect(normalizeMessagingLimit('TIER_250')).toBe('TIER_250')
    expect(normalizeMessagingLimit('TIER_2K')).toBe('TIER_2K')
    expect(normalizeMessagingLimit('tier_10k')).toBe('TIER_10K')
    expect(normalizeMessagingLimit('TIER_UNLIMITED')).toBe('UNLIMITED')
    expect(normalizeMessagingLimit('UNLIMITED')).toBe('UNLIMITED')
    expect(normalizeMessagingLimit(250)).toBe('TIER_250')
    expect(normalizeMessagingLimit(2000)).toBe('TIER_2K')
    expect(normalizeMessagingLimit('100000')).toBe('TIER_100K')
    expect(normalizeMessagingLimit(-1)).toBe('UNLIMITED')
  })
  it('is null for nothing, and keeps an unknown value visible', () => {
    for (const v of [null, undefined, '', '  ']) expect(normalizeMessagingLimit(v)).toBeNull()
    expect(normalizeMessagingLimit('TIER_1M')).toBe('TIER_1M')
    expect(normalizeMessagingLimit(500)).toBe('500')
  })
})

describe('the 2,000 tier', () => {
  it('ranks between 1,000 and 10,000 and is labelled', () => {
    expect(tierDowngraded('TIER_10K', 'TIER_2K')).toBe(true)
    expect(tierDowngraded('TIER_2K', 'TIER_250')).toBe(true)
    expect(tierDowngraded('TIER_250', 'TIER_2K')).toBe(false)
    expect(tierLabel('TIER_2K')).toBe('2,000 / day')
  })
  it('isKnownTier separates a usable tier from an unknown one', () => {
    expect(isKnownTier('TIER_2K')).toBe(true)
    expect(isKnownTier('UNLIMITED')).toBe(true)
    for (const v of [null, undefined, '', 'TIER_1M', 'toString']) expect(isKnownTier(v)).toBe(false)
  })
})

describe('fetchNumberHealth — the messaging limit (WA-LIMIT.1)', () => {
  const realFetch = globalThis.fetch
  const answers = (core, limit) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return { json: async () => (String(url).includes(MESSAGING_LIMIT_FIELD) ? limit : core) }
    }
    return calls
  }
  const restore = () => { globalThis.fetch = realFetch }

  it('reads the limit from the new field, in its own request, with the token in the header', async () => {
    const calls = answers({ quality_rating: 'GREEN', name_status: 'APPROVED' }, { [MESSAGING_LIMIT_FIELD]: 'TIER_2K', id: 'p1' })
    try {
      const health = await fetchNumberHealth({ phoneNumberId: 'p1', token: 't' })
      expect(health).toEqual({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_2K', name_status: 'APPROVED', limit_error: null })
      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe(`https://graph.facebook.com/v25.0/p1?fields=${MESSAGING_LIMIT_FIELD}`)
      expect(calls[1].init.headers.Authorization).toBe('Bearer t')
      expect(calls[1].url).not.toContain('access_token')
    } finally { restore() }
  })

  it('a refusal of the new field costs only the limit, never the quality rating', async () => {
    answers({ quality_rating: 'YELLOW', name_status: 'APPROVED' }, { error: { message: '(#100) Tried accessing nonexisting field', code: 100 } })
    try {
      const health = await fetchNumberHealth({ phoneNumberId: 'p1', token: 't' })
      expect(health.quality_rating).toBe('YELLOW')
      expect(health.messaging_limit_tier).toBeNull()
      expect(health.limit_error).toBe('(#100) Tried accessing nonexisting field')
    } finally { restore() }
  })

  it('falls back to the old field while Meta still returns it', async () => {
    answers({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }, { id: 'p1' })
    try {
      const health = await fetchNumberHealth({ phoneNumberId: 'p1', token: 't' })
      expect(health.messaging_limit_tier).toBe('TIER_1K')
    } finally { restore() }
  })

  it('fetchMessagingLimit never throws', async () => {
    globalThis.fetch = async () => { throw new Error('socket hang up') }
    try {
      expect(await fetchMessagingLimit({ phoneNumberId: 'p1', token: 't' })).toEqual({ tier: null, error: 'socket hang up' })
    } finally { restore() }
  })
})
