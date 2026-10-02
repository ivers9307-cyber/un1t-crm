// C120 GATES-3 (b) — who may create, edit, resubmit or delete a WhatsApp
// template at a studio: MANAGER_ROLES there (WATPLROLE.1) AND the `whatsapp`
// permission there. The routes and the pages share this one rule.
import { describe, it, expect } from 'vitest'
import { canManageWaTemplatesAt } from './wa-template-access'
import { person, MASTER, masterFeatureOffAtB, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

describe('canManageWaTemplatesAt', () => {
  it('a manager with whatsapp at the studio may', () => {
    const u = person({ [LOC_A]: { role: 'manager', permissions: { whatsapp: true } } }, LOC_A)
    expect(canManageWaTemplatesAt(u, LOC_A)).toBe(true)
  })
  it('a manager with whatsapp switched off at the studio may not', () => {
    const u = person({ [LOC_A]: { role: 'manager', permissions: { whatsapp: false } } }, LOC_A)
    expect(canManageWaTemplatesAt(u, LOC_A)).toBe(false)
  })
  it('staff with whatsapp may not (the role half)', () => {
    const u = person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
    expect(canManageWaTemplatesAt(u, LOC_A)).toBe(false)
  })
  it('judges the TARGET studio, not the active one', () => {
    const u = person({ [LOC_A]: { role: 'manager', permissions: { whatsapp: true } }, [LOC_B]: { role: 'manager', permissions: { whatsapp: false } } }, LOC_A)
    expect(canManageWaTemplatesAt(u, LOC_B)).toBe(false)
    expect(canManageWaTemplatesAt(u, LOC_A)).toBe(true)
  })
  it('a master may, unless the feature is off at the studio', () => {
    expect(canManageWaTemplatesAt(MASTER, LOC_B)).toBe(true)
    expect(canManageWaTemplatesAt(masterFeatureOffAtB('whatsapp'), LOC_B)).toBe(false)
  })
  it('no user or no studio fails closed', () => {
    expect(canManageWaTemplatesAt(null, LOC_A)).toBe(false)
    expect(canManageWaTemplatesAt(MASTER, null)).toBe(false)
  })
})

// C138 (a) — the template-media upload routes (sign + finalise).
import { canUploadWaTemplateMediaAt } from './wa-template-access'
describe('canUploadWaTemplateMediaAt', () => {
  it('whoever may manage the templates there may', () => {
    expect(canUploadWaTemplateMediaAt(person({ [LOC_A]: { role: 'head_coach', permissions: { whatsapp: true } } }, LOC_A), LOC_A)).toBe(true)
  })
  it('an owner there may with whatsapp off (the card-set editor rule)', () => {
    expect(canUploadWaTemplateMediaAt(person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: false } } }, LOC_A), LOC_A)).toBe(true)
  })
  it('a manager with whatsapp off, or plain staff, may not', () => {
    expect(canUploadWaTemplateMediaAt(person({ [LOC_A]: { role: 'manager', permissions: { whatsapp: false } } }, LOC_A), LOC_A)).toBe(false)
    expect(canUploadWaTemplateMediaAt(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A), LOC_A)).toBe(false)
  })
  it('judges the target studio; no user or studio fails closed', () => {
    const u = person({ [LOC_A]: { role: 'owner', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)
    expect(canUploadWaTemplateMediaAt(u, LOC_B)).toBe(false)
    expect(canUploadWaTemplateMediaAt(null, LOC_A)).toBe(false)
    expect(canUploadWaTemplateMediaAt(MASTER, null)).toBe(false)
    expect(canUploadWaTemplateMediaAt(MASTER, LOC_B)).toBe(true)
  })
})
