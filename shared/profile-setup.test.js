import { describe, it, expect } from 'vitest'
import {
  profileSetupStatus,
  validateAboutYou,
  normalizeWeightKg,
  missingCalorieFields,
  blocksCalories,
  shouldShowCompletionPrompt,
  calorieFieldLabel,
  COMPLETION_SNOOZE_MS,
} from './profile-setup.js'

const DAY = 86400000

describe('profileSetupStatus', () => {
  const now = Date.parse('2026-06-27T12:00:00Z')
  it('complete when the contact has a completion timestamp', () => {
    expect(profileSetupStatus({ profile_setup_completed_at: '2026-06-01T00:00:00Z' }, { dismissedAtMs: null, nowMs: now })).toBe('complete')
  })
  it('wizard when incomplete and never dismissed', () => {
    expect(profileSetupStatus({ profile_setup_completed_at: null }, { dismissedAtMs: null, nowMs: now })).toBe('wizard')
  })
  it('nudge (not wizard) when incomplete but dismissed within the cooldown', () => {
    expect(profileSetupStatus({ profile_setup_completed_at: null }, { dismissedAtMs: now - 2 * 3600000, nowMs: now })).toBe('nudge')
  })
  it('wizard again once the dismissal cooldown (24h) has passed', () => {
    expect(profileSetupStatus({ profile_setup_completed_at: null }, { dismissedAtMs: now - 2 * DAY, nowMs: now })).toBe('wizard')
  })
  it('complete for a null contact (nothing to set up / not loaded)', () => {
    expect(profileSetupStatus(null, { dismissedAtMs: null, nowMs: now })).toBe('complete')
  })
})

describe('validateAboutYou', () => {
  const good = { dob: '1990-03-12', gender: 'male', weight_kg: 68 }
  it('accepts a complete valid form', () => {
    expect(validateAboutYou(good)).toEqual({ ok: true })
  })
  it('requires all three fields', () => {
    expect(validateAboutYou({ ...good, gender: null }).ok).toBe(false)
    expect(validateAboutYou({ ...good, dob: '' }).ok).toBe(false)
    expect(validateAboutYou({ ...good, weight_kg: null }).ok).toBe(false)
  })
  it('bounds weight to 20–300 kg', () => {
    expect(validateAboutYou({ ...good, weight_kg: 10 }).ok).toBe(false)
    expect(validateAboutYou({ ...good, weight_kg: 400 }).ok).toBe(false)
  })
  it('rejects a malformed or future dob', () => {
    expect(validateAboutYou({ ...good, dob: '12/03/1990' }).ok).toBe(false)
    expect(validateAboutYou({ ...good, dob: '2999-01-01' }).ok).toBe(false)
  })
  it('only allows female/male/other for gender', () => {
    expect(validateAboutYou({ ...good, gender: 'P' }).ok).toBe(false)
  })
})

describe('missingCalorieFields / blocksCalories', () => {
  const complete = { dob: '1990-03-12', gender: 'male', weight_kg: 68 }

  it('returns none when all metrics are present and valid', () => {
    expect(missingCalorieFields(complete)).toEqual([])
    expect(blocksCalories(complete)).toBe(false)
  })

  it('flags every field when the contact is empty', () => {
    expect(missingCalorieFields({})).toEqual(['dob', 'gender', 'weight_kg'])
    expect(blocksCalories({})).toBe(true)
  })

  it('returns [] (not a crash) for a null contact', () => {
    expect(missingCalorieFields(null)).toEqual([])
    expect(blocksCalories(null)).toBe(false)
  })

  it('flags a partial profile — missing dob and weight only', () => {
    expect(missingCalorieFields({ gender: 'female', dob: null, weight_kg: null }))
      .toEqual(['dob', 'weight_kg'])
    expect(blocksCalories({ gender: 'female' })).toBe(true)
  })

  it('treats a present-but-invalid value as missing', () => {
    // legacy 'P' gender, out-of-range weight, future dob
    expect(missingCalorieFields({ gender: 'P', weight_kg: 5, dob: '2999-01-01' }))
      .toEqual(['dob', 'gender', 'weight_kg'])
  })

  it('accepts a numeric-string weight (as it arrives from the DB)', () => {
    expect(missingCalorieFields({ ...complete, weight_kg: '68.0' })).toEqual([])
  })

  it('keeps canonical dob→gender→weight order regardless of which are missing', () => {
    expect(missingCalorieFields({ gender: null, weight_kg: null, dob: null }))
      .toEqual(['dob', 'gender', 'weight_kg'])
  })

  it('labels field keys for display', () => {
    expect(calorieFieldLabel('dob')).toBe('Date of birth')
    expect(calorieFieldLabel('gender')).toBe('Gender')
    expect(calorieFieldLabel('weight_kg')).toBe('Weight')
  })
})

describe('shouldShowCompletionPrompt', () => {
  const now = Date.parse('2026-06-27T12:00:00Z')
  const missing = { gender: null, weight_kg: null, dob: null }
  const complete = { dob: '1990-03-12', gender: 'male', weight_kg: 68 }

  it('shows when a metric is missing and never snoozed', () => {
    expect(shouldShowCompletionPrompt(missing, { snoozedAtMs: null, nowMs: now })).toBe(true)
  })

  it('never shows once the fields are filled — even if never snoozed', () => {
    expect(shouldShowCompletionPrompt(complete, { snoozedAtMs: null, nowMs: now })).toBe(false)
  })

  it('hides while inside the snooze window', () => {
    expect(shouldShowCompletionPrompt(missing, { snoozedAtMs: now - 2 * 86400000, nowMs: now })).toBe(false)
  })

  it('re-appears once the snooze window elapses (snooze, not permanent)', () => {
    expect(shouldShowCompletionPrompt(missing, { snoozedAtMs: now - COMPLETION_SNOOZE_MS - 1, nowMs: now })).toBe(true)
  })
})

describe('normalizeWeightKg', () => {
  it('parses a numeric string to a number', () => {
    expect(normalizeWeightKg('68.5')).toBe(68.5)
  })
  it('returns null for junk', () => {
    expect(normalizeWeightKg('abc')).toBeNull()
    expect(normalizeWeightKg('')).toBeNull()
  })
})
