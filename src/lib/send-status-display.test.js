// COMMS-DETAIL-FIX.4 — one status vocabulary across the three channels.

import { describe, it, expect } from 'vitest'
import { sendStatusDisplay, SEND_STATUS_KEYS } from './send-status-display.js'

describe('sendStatusDisplay', () => {
  it('title-cases every known status (WhatsApp used to print the raw column)', () => {
    for (const key of SEND_STATUS_KEYS) {
      const d = sendStatusDisplay(key)
      expect(d.label[0]).toBe(d.label[0].toUpperCase())
      expect(d.label).not.toBe(key)
    }
  })

  it('uses the light-theme chip recipe for every status', () => {
    for (const key of SEND_STATUS_KEYS) {
      const { cls } = sendStatusDisplay(key)
      expect(cls, key).toMatch(/bg-[a-z]+-500\/10\b/)
      expect(cls, key).toMatch(/text-[a-z]+-700\b/)
      // The /20 wash WhatsApp used is below the readable ramp.
      expect(cls, key).not.toMatch(/\/(15|20|30)\b/)
    }
  })

  it('is case-insensitive on the stored value', () => {
    expect(sendStatusDisplay('SENT').label).toBe('Sent')
  })

  it('gives an unplanned status a readable label rather than the raw value', () => {
    const d = sendStatusDisplay('awaiting_review')
    expect(d.label).toBe('Awaiting review')
    expect(d.cls).toMatch(/bg-[a-z]+-500\/10\b/)
  })

  it('returns null for no status, so a header can omit the slot', () => {
    expect(sendStatusDisplay(null)).toBeNull()
    expect(sendStatusDisplay('')).toBeNull()
    expect(sendStatusDisplay(undefined)).toBeNull()
  })
})
