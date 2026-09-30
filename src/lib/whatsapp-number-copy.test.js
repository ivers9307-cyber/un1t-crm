// WACONFIGFALLBACK.1 — the staff-facing copy for removing or deactivating a
// WhatsApp number. There is no env fallback any more, so a studio's LAST
// active number going away turns WhatsApp off there, and the confirm must
// say so. Rows come in two shapes (the tab's snake_case, the hub drawer's
// camelCase); both are read.

import { describe, it, expect } from 'vitest'
import {
  NO_ACTIVE_NUMBER_NOTE,
  BROKEN_TOKEN_HINT,
  ACTIVE_CHECKBOX_LABEL,
  isLastActiveNumber,
  removeNumberConfirm,
  deactivateNumberConfirm,
} from './whatsapp-number-copy.js'

const A = { id: 'a', label: 'Front desk', is_active: true }
const B = { id: 'b', label: 'Back office', is_active: true }
const OFF = { id: 'c', label: 'Old number', is_active: false }
const STOPS = /WhatsApp stops at this studio: Mia stops replying, and booking confirmations and reminders are no longer sent/

describe('isLastActiveNumber', () => {
  it('the only active row is the last one (snake_case and camelCase rows)', () => {
    expect(isLastActiveNumber(A, [A, OFF])).toBe(true)
    expect(isLastActiveNumber({ id: 'a', isActive: true }, [{ id: 'a', isActive: true }, { id: 'c', isActive: false }])).toBe(true)
  })
  it('another active row → not the last; an inactive row is never the last active', () => {
    expect(isLastActiveNumber(A, [A, B])).toBe(false)
    expect(isLastActiveNumber(OFF, [A, OFF])).toBe(false)
  })
})

describe('removeNumberConfirm', () => {
  it('the last active number says WhatsApp stops at this studio, and how to fix a token instead', () => {
    const msg = removeNumberConfirm(A, [A, OFF])
    expect(msg).toMatch(/^Remove "Front desk"\?/)
    expect(msg).toMatch(STOPS)
    expect(msg).toContain(BROKEN_TOKEN_HINT)
  })
  it('with another active number: sends continue from it (never an env default)', () => {
    const msg = removeNumberConfirm(A, [A, B])
    expect(msg).toMatch(/keeps using its other active number/)
    expect(msg).not.toMatch(/env/i)
    expect(msg).not.toMatch(STOPS)
  })
  it('an inactive row at a studio with no active number: WhatsApp is already off there', () => {
    expect(removeNumberConfirm(OFF, [OFF])).toMatch(/has no active number, so it does not send or receive WhatsApp/)
  })
  it('no copy promises a fallback or uses an em-dash', () => {
    for (const msg of [removeNumberConfirm(A, [A]), removeNumberConfirm(A, [A, B]), removeNumberConfirm(OFF, [OFF]), deactivateNumberConfirm(A, [A]), NO_ACTIVE_NUMBER_NOTE, ACTIVE_CHECKBOX_LABEL]) {
      expect(msg).not.toMatch(/fall(s)? back|env/i)
      expect(msg).not.toContain('—')
    }
  })
})

describe('deactivateNumberConfirm', () => {
  it('the last active number: explicit WhatsApp-stops warning', () => {
    const msg = deactivateNumberConfirm(A, [A])
    expect(msg).toMatch(/^Deactivate "Front desk"\?/)
    expect(msg).toMatch(STOPS)
    expect(msg).toContain(BROKEN_TOKEN_HINT)
  })
  it('not the last active number: no confirm needed (null)', () => {
    expect(deactivateNumberConfirm(A, [A, B])).toBeNull()
  })
})

describe('the standing notes', () => {
  it('say a studio without an active number does not send or receive WhatsApp', () => {
    expect(NO_ACTIVE_NUMBER_NOTE).toBe('This location will not send or receive WhatsApp while it has no active number.')
    expect(BROKEN_TOKEN_HINT).toBe('To fix a broken token, paste a new one instead of removing or deactivating the number.')
    expect(ACTIVE_CHECKBOX_LABEL).toMatch(/inactive number sends and receives no WhatsApp/)
  })
})
