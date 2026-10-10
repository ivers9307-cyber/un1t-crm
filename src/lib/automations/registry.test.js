import { describe, it, expect } from 'vitest'
import { AUTOMATIONS, getAutomation, glofoxConnected, automationStatus } from './registry.js'

const connected = { settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't', trial_membership_id: 'm', trial_plan_code: 'p' } } }
const noTrial   = { settings: { glofox: { branch_id: 'b', api_key: 'k', api_token: 't' } } }
const notConn   = { settings: { glofox: { branch_id: 'your-glofox-branch-id' } } }

describe('automations registry', () => {
  it('registers the glofox_lead_provisioning automation', () => {
    expect(AUTOMATIONS.map((a) => a.key)).toContain('glofox_lead_provisioning')
    expect(getAutomation('glofox_lead_provisioning').label).toBeTruthy()
    expect(getAutomation('nope')).toBeNull()
  })

  it('glofoxConnected requires branch_id + api_key + api_token', () => {
    expect(glofoxConnected(connected)).toBe(true)
    expect(glofoxConnected(noTrial)).toBe(true)
    expect(glofoxConnected(notConn)).toBe(false)
    expect(glofoxConnected(null)).toBe(false)
    expect(glofoxConnected({})).toBe(false)
  })

  it('automationStatus reports connection + trial config', () => {
    expect(automationStatus('glofox_lead_provisioning', connected)).toEqual({ available: true, trialConfigured: true })
    expect(automationStatus('glofox_lead_provisioning', noTrial)).toEqual({ available: true, trialConfigured: false })
    expect(automationStatus('glofox_lead_provisioning', notConn)).toEqual({ available: false, trialConfigured: false })
  })

  // W1.M3a — the membership-source answer, when given, IS the connection
  // test; the settings slice is consulted only for the trial config. The
  // slice-only call above is the deprecated fallback, pinned until it goes.
  it('automationStatus: an explicit `connected` wins over the settings slice', () => {
    expect(automationStatus('glofox_lead_provisioning', notConn, { connected: true })).toEqual({ available: true, trialConfigured: false })
    expect(automationStatus('glofox_lead_provisioning', connected, { connected: false })).toEqual({ available: false, trialConfigured: true })
    expect(automationStatus('class_climate', notConn, { connected: true })).toEqual({ available: true, trialConfigured: false })
    expect(automationStatus('class_climate', connected, { connected: false })).toEqual({ available: false, trialConfigured: false })
    expect(automationStatus('class_climate', null, { connected: true })).toEqual({ available: true, trialConfigured: false })
    // Not a boolean → the fallback (no accidental "connected" from a truthy object).
    expect(automationStatus('class_climate', notConn, { connected: 'yes' })).toEqual({ available: false, trialConfigured: false })
    expect(automationStatus('class_climate', connected, {})).toEqual({ available: true, trialConfigured: false })
  })
})
