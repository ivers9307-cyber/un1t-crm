// WAORGNUMBER.1 — the /communications hub's WhatsApp health card reads the
// number switched on at the studio (link default first), whatever its home.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { loadWhatsAppHubHealth } from './wa-hub-health.js'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { logWarn } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-000000000001'

beforeEach(() => vi.clearAllMocks())

describe('loadWhatsAppHubHealth', () => {
  it('the switched-on number’s quality, tier and last check, in the card’s column names', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue({
      id: 'n1', homeLocationId: 'b0000000-0000-4000-8000-000000000002',
      qualityRating: 'GREEN', messagingLimitTier: 'TIER_1K', qualityCheckedAt: '2026-10-17T10:00:00Z',
    })
    expect(await loadWhatsAppHubHealth(LOC)).toEqual({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', quality_checked_at: '2026-10-17T10:00:00Z' })
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
  })
  it('never fetched columns stay null (the card says Checking…)', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue({ id: 'n1' })
    expect(await loadWhatsAppHubHealth(LOC)).toEqual({ quality_rating: null, messaging_limit_tier: null, quality_checked_at: null })
  })
  it('no number switched on → null (no card)', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    expect(await loadWhatsAppHubHealth(LOC)).toBeNull()
  })
  it('a failed read hides the card, logged, never throws into the page', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('boom'))
    expect(await loadWhatsAppHubHealth(LOC)).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('communications-hub', expect.any(String), expect.objectContaining({ locationId: LOC, err: 'boom' }))
  })
})
