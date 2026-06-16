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
})
