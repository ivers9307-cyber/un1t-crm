// Sanity tests for the enum constants. We can't (yet) reach out
// to the live DB in this test runner, so the assertions here are
// limited to:
//   - every constant set has at least one value
//   - values are unique within a set
//   - the frozen object is actually frozen
//   - the *_VALUES array matches Object.values of the constant
//   - known values that already shipped in app code are present
//
// A future task will add a release-time check that compares each
// set against pg_constraint definitions; that needs DB access so
// it lives outside this unit test.

import { describe, it, expect } from 'vitest'
import {
  AC_SESSION_STATUS, AC_SESSION_STATUS_VALUES, AC_SESSION_ACTIVE_STATUSES,
  CONTRACT_STATUS, CONTRACT_STATUS_VALUES, CONTRACT_PENDING_STATUSES,
  CONTRACTOR_INVOICE_STATUS, CONTRACTOR_INVOICE_STATUS_VALUES,
  ORDER_STATUS, ORDER_STATUS_VALUES,
  ORDER_SOURCE_TYPE, ORDER_SOURCE_TYPE_VALUES,
  RACE_PAYMENT_STATUS, RACE_PAYMENT_STATUS_VALUES,
  RACE_REGISTRATION_STATUS, RACE_REGISTRATION_STATUS_VALUES,
  TIME_OFF_STATUS, TIME_OFF_STATUS_VALUES,
  TIME_OFF_TYPE, TIME_OFF_TYPE_VALUES,
  EMPLOYMENT_TYPE, EMPLOYMENT_TYPE_VALUES,
  EMPLOYMENT_TYPE_FOR_TEMPLATE, EMPLOYMENT_TYPE_FOR_TEMPLATE_VALUES,
  LOCATION_ROLE, LOCATION_ROLE_VALUES,
  DEVICE_PLATFORM, DEVICE_PLATFORM_VALUES,
  CAR_STATUS, CAR_STATUS_VALUES,
  CAR_DEPOSIT_STATUS, CAR_DEPOSIT_STATUS_VALUES,
  CONTACT_IMPORT_STATUS, CONTACT_IMPORT_STATUS_VALUES,
  CONTACT_IMPORT_ROW_ACTION, CONTACT_IMPORT_ROW_ACTION_VALUES,
  TEAM_MEMBER_ROLE, TEAM_MEMBER_ROLE_VALUES,
  EMAIL_TICKET_STATUS, EMAIL_TICKET_STATUS_VALUES,
  EMAIL_TICKET_PRIORITY, EMAIL_TICKET_PRIORITY_VALUES,
} from './enums.js'

const ALL_SETS = [
  ['AC_SESSION_STATUS', AC_SESSION_STATUS, AC_SESSION_STATUS_VALUES],
  ['CONTRACT_STATUS', CONTRACT_STATUS, CONTRACT_STATUS_VALUES],
  ['CONTRACTOR_INVOICE_STATUS', CONTRACTOR_INVOICE_STATUS, CONTRACTOR_INVOICE_STATUS_VALUES],
  ['ORDER_STATUS', ORDER_STATUS, ORDER_STATUS_VALUES],
  ['ORDER_SOURCE_TYPE', ORDER_SOURCE_TYPE, ORDER_SOURCE_TYPE_VALUES],
  ['RACE_PAYMENT_STATUS', RACE_PAYMENT_STATUS, RACE_PAYMENT_STATUS_VALUES],
  ['RACE_REGISTRATION_STATUS', RACE_REGISTRATION_STATUS, RACE_REGISTRATION_STATUS_VALUES],
  ['TIME_OFF_STATUS', TIME_OFF_STATUS, TIME_OFF_STATUS_VALUES],
  ['TIME_OFF_TYPE', TIME_OFF_TYPE, TIME_OFF_TYPE_VALUES],
  ['EMPLOYMENT_TYPE', EMPLOYMENT_TYPE, EMPLOYMENT_TYPE_VALUES],
  ['EMPLOYMENT_TYPE_FOR_TEMPLATE', EMPLOYMENT_TYPE_FOR_TEMPLATE, EMPLOYMENT_TYPE_FOR_TEMPLATE_VALUES],
  ['LOCATION_ROLE', LOCATION_ROLE, LOCATION_ROLE_VALUES],
  ['DEVICE_PLATFORM', DEVICE_PLATFORM, DEVICE_PLATFORM_VALUES],
  ['CAR_STATUS', CAR_STATUS, CAR_STATUS_VALUES],
  ['CAR_DEPOSIT_STATUS', CAR_DEPOSIT_STATUS, CAR_DEPOSIT_STATUS_VALUES],
  ['CONTACT_IMPORT_STATUS', CONTACT_IMPORT_STATUS, CONTACT_IMPORT_STATUS_VALUES],
  ['CONTACT_IMPORT_ROW_ACTION', CONTACT_IMPORT_ROW_ACTION, CONTACT_IMPORT_ROW_ACTION_VALUES],
  ['TEAM_MEMBER_ROLE', TEAM_MEMBER_ROLE, TEAM_MEMBER_ROLE_VALUES],
  ['EMAIL_TICKET_STATUS', EMAIL_TICKET_STATUS, EMAIL_TICKET_STATUS_VALUES],
  ['EMAIL_TICKET_PRIORITY', EMAIL_TICKET_PRIORITY, EMAIL_TICKET_PRIORITY_VALUES],
]

describe('enums — universal invariants', () => {
  it.each(ALL_SETS)('%s has at least one value', (_name, constants) => {
    expect(Object.values(constants).length).toBeGreaterThan(0)
  })

  it.each(ALL_SETS)('%s values are unique', (_name, constants) => {
    const values = Object.values(constants)
    expect(new Set(values).size).toBe(values.length)
  })

  it.each(ALL_SETS)('%s constants object is frozen', (_name, constants) => {
    expect(Object.isFrozen(constants)).toBe(true)
  })

  it.each(ALL_SETS)('%s _VALUES matches Object.values of the constant set',
    (_name, constants, valuesArray) => {
      expect(valuesArray).toEqual(Object.values(constants))
    })
})

describe('enums — known shipped values', () => {
  it('AC_SESSION_STATUS includes manual_off (used by external-stop reconcile)', () => {
    expect(AC_SESSION_STATUS_VALUES).toContain('manual_off')
  })

  it('AC_SESSION_ACTIVE_STATUSES is the same shape used by the auto-off cron query', () => {
    expect(AC_SESSION_ACTIVE_STATUSES).toEqual(['on', 'extended'])
  })

  it('CONTRACT_PENDING_STATUSES matches the recipient-banner query', () => {
    expect(CONTRACT_PENDING_STATUSES).toEqual(['issued', 'viewed'])
  })

  it('ORDER_STATUS.RECOVERED exists (dunning flow)', () => {
    expect(ORDER_STATUS.RECOVERED).toBe('recovered')
  })

  it('EMPLOYMENT_TYPE never has "both" (only templates do)', () => {
    expect(EMPLOYMENT_TYPE_VALUES).not.toContain('both')
    expect(EMPLOYMENT_TYPE_FOR_TEMPLATE_VALUES).toContain('both')
  })

  it('LOCATION_ROLE has no master (master is a separate boolean)', () => {
    expect(LOCATION_ROLE_VALUES).not.toContain('master')
  })
})
