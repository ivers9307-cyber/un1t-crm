// STAFFPAYLINK.1 — who may send a un1t.online payment link: the
// un1t_payment_links web permission, resolved at the studio (owner, manager
// and reception by default; head coach and staff off; master always).
import { describe, it, expect } from 'vitest'
import { canSendUn1tPaymentLink, UN1T_PAYMENT_LINKS_PERMISSION } from './un1t-payment-link-access.js'
import { WEB_PERMISSIONS, DEFAULT_WEB_PERMISSIONS_BY_ROLE } from '@shared/permissions'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const userAt = (role, { locId = HATCH, permissions = {}, template = null, features = {}, otherRole = null } = {}) => ({
  id: 'u-1',
  role: otherRole ?? role,
  locations: [{ id: locId, role, features }],
  assignmentsByLocation: { [locId]: { role, permissions } },
  roleTemplatesByLocation: template ? { [locId]: template } : {},
})

describe('the permission key', () => {
  it('is a web permission labelled "Send payment links"', () => {
    expect(UN1T_PAYMENT_LINKS_PERMISSION).toBe('un1t_payment_links')
    const entry = WEB_PERMISSIONS.find((p) => p.key === 'un1t_payment_links')
    expect(entry?.label).toBe('Send payment links')
  })
  it('defaults: owner, manager and reception on; head coach and staff off', () => {
    const d = DEFAULT_WEB_PERMISSIONS_BY_ROLE
    expect([d.owner, d.manager, d.reception].map((r) => r.un1t_payment_links)).toEqual([true, true, true])
    expect([d.head_coach, d.staff].map((r) => r.un1t_payment_links)).toEqual([false, false])
  })
  it('master defaults on', () => {
    expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE.master.un1t_payment_links).toBe(true)
  })
})

describe('canSendUn1tPaymentLink', () => {
  it('owner, manager and reception at the studio may; head coach and staff may not', () => {
    for (const role of ['owner', 'manager', 'reception']) expect(canSendUn1tPaymentLink(userAt(role), HATCH), role).toBe(true)
    for (const role of ['head_coach', 'staff']) expect(canSendUn1tPaymentLink(userAt(role), HATCH), role).toBe(false)
  })

  it('is judged at the studio: a manager elsewhere who is staff here may not', () => {
    const u = {
      id: 'u-2', role: 'manager',
      locations: [{ id: STILL, role: 'manager' }, { id: HATCH, role: 'staff' }],
      assignmentsByLocation: { [STILL]: { role: 'manager', permissions: {} }, [HATCH]: { role: 'staff', permissions: {} } },
      roleTemplatesByLocation: {},
    }
    expect(canSendUn1tPaymentLink(u, STILL)).toBe(true)
    expect(canSendUn1tPaymentLink(u, HATCH)).toBe(false)
    expect(canSendUn1tPaymentLink(userAt('owner', { locId: STILL }), HATCH)).toBe(false)
  })

  it('a role template at the studio is honoured both ways', () => {
    expect(canSendUn1tPaymentLink(userAt('reception', { template: { un1t_payment_links: false } }), HATCH)).toBe(false)
    expect(canSendUn1tPaymentLink(userAt('head_coach', { template: { un1t_payment_links: true } }), HATCH)).toBe(true)
  })

  it('a per-user override beats the template', () => {
    expect(canSendUn1tPaymentLink(userAt('staff', { permissions: { un1t_payment_links: true }, template: { un1t_payment_links: false } }), HATCH)).toBe(true)
    expect(canSendUn1tPaymentLink(userAt('owner', { permissions: { un1t_payment_links: false } }), HATCH)).toBe(false)
  })

  it('master may anywhere the studio switch allows; the studio switch denies everyone', () => {
    const master = { id: 'm', role: 'master', locations: [{ id: HATCH, features: {} }], assignmentsByLocation: {}, roleTemplatesByLocation: {} }
    expect(canSendUn1tPaymentLink(master, HATCH)).toBe(true)
    const off = { ...master, locations: [{ id: HATCH, features: { un1t_payment_links: false } }] }
    expect(canSendUn1tPaymentLink(off, HATCH)).toBe(false)
    expect(canSendUn1tPaymentLink(userAt('owner', { features: { un1t_payment_links: false } }), HATCH)).toBe(false)
  })

  it('nobody, and no studio, is no', () => {
    expect(canSendUn1tPaymentLink(null, HATCH)).toBe(false)
    expect(canSendUn1tPaymentLink(userAt('owner'), null)).toBe(false)
  })
})
