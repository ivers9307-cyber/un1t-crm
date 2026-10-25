// WACONFIGFALLBACK.1 / WAORGNUMBER.1 — the staff-facing copy for removing or
// deactivating a WhatsApp number. There is no env fallback, and since
// WAORGNUMBER.1 a number belongs to the organisation: removing or deactivating
// it acts at every studio that has it switched on, and the confirm says so.

import { describe, it, expect } from 'vitest'
import {
  NO_ACTIVE_NUMBER_NOTE,
  BROKEN_TOKEN_HINT,
  ACTIVE_CHECKBOX_LABEL,
  removeNumberConfirm,
  deactivateNumberConfirm,
} from './whatsapp-number-copy.js'

const A = { id: 'a', label: 'Front desk', is_active: true }
const EVERY_STUDIO = /Every studio that has it switched on loses it/
const STOPS = /a studio with no other number switched on stops sending and receiving WhatsApp/

describe('removeNumberConfirm', () => {
  it('says it is deleted for good, that every studio using it loses it, and how to fix a token instead', () => {
    const msg = removeNumberConfirm(A)
    expect(msg).toMatch(/^Remove "Front desk"\? It is deleted for good\./)
    expect(msg).toMatch(EVERY_STUDIO)
    expect(msg).toMatch(STOPS)
    expect(msg).toContain(BROKEN_TOKEN_HINT)
  })
})

describe('deactivateNumberConfirm', () => {
  it('says every studio using it loses it, and how to fix a token instead', () => {
    const msg = deactivateNumberConfirm(A)
    expect(msg).toMatch(/^Deactivate "Front desk"\?/)
    expect(msg).toMatch(EVERY_STUDIO)
    expect(msg).toContain(BROKEN_TOKEN_HINT)
  })
})

describe('the copy', () => {
  it('promises no fallback and uses no em-dash', () => {
    for (const msg of [removeNumberConfirm(A), deactivateNumberConfirm(A), NO_ACTIVE_NUMBER_NOTE, ACTIVE_CHECKBOX_LABEL]) {
      expect(msg).not.toMatch(/fall(s)? back|env/i)
      expect(msg).not.toContain('—')
    }
  })

  it('the standing notes say a studio without an active number does not send or receive WhatsApp', () => {
    expect(NO_ACTIVE_NUMBER_NOTE).toBe('This location will not send or receive WhatsApp while it has no active number.')
    expect(BROKEN_TOKEN_HINT).toBe('To fix a broken token, paste a new one instead of removing or deactivating the number.')
    expect(ACTIVE_CHECKBOX_LABEL).toMatch(/inactive number sends and receives no WhatsApp/)
  })
})
