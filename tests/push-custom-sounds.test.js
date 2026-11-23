// SALEALERT.2 — a custom push sound is three things that must agree: the
// name the server sends (PUSH_CUSTOM_SOUNDS), the file in mobile/assets, and
// the expo-notifications plugin's `sounds` list that copies it into the
// binary. A name with no bundled file plays the default chime, silently.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUSH_CUSTOM_SOUNDS } from '@/lib/push'
import { SALE_ALERT_SOUND } from '@/lib/sale-alert'

const root = join(__dirname, '..')
const appConfig = readFileSync(join(root, 'mobile/app.config.js'), 'utf8')

describe('custom push sounds', () => {
  it('the sale alert sound is an allowed custom sound', () => {
    expect(PUSH_CUSTOM_SOUNDS).toContain(SALE_ALERT_SOUND)
  })

  it.each(PUSH_CUSTOM_SOUNDS)('%s is bundled: file present and listed in the plugin sounds', (name) => {
    const file = join(root, 'mobile/assets/sounds', name)
    expect(existsSync(file)).toBe(true)
    // iOS refuses a notification sound of 30 seconds or more; this is a size
    // sanity bound, not a duration check.
    expect(statSync(file).size).toBeGreaterThan(1000)
    expect(statSync(file).size).toBeLessThan(2_000_000)
    expect(appConfig).toContain(`'./assets/sounds/${name}'`)
  })
})
