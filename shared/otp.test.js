// shared/otp.test.js
import { describe, it, expect } from 'vitest'
import { EMAIL_OTP_LENGTH, OTP_PLACEHOLDER, normalizeOtpInput, isCompleteOtp } from './otp'

describe('EMAIL_OTP_LENGTH', () => {
  it('is 8 — the length this Supabase project mints for emailed login codes', () => {
    expect(EMAIL_OTP_LENGTH).toBe(8)
  })
})

describe('OTP_PLACEHOLDER', () => {
  it('counts out one digit per position so the hint matches the real code length', () => {
    expect(OTP_PLACEHOLDER).toBe('12345678')
    expect(OTP_PLACEHOLDER).toHaveLength(EMAIL_OTP_LENGTH)
  })
})

describe('normalizeOtpInput', () => {
  it('keeps every digit of an emailed code', () => {
    expect(normalizeOtpInput('84213907')).toBe('84213907')
  })
  it('strips spaces and separators from a pasted code', () => {
    expect(normalizeOtpInput(' 8421 3907 ')).toBe('84213907')
    expect(normalizeOtpInput('8421-3907')).toBe('84213907')
  })
  it('drops keystrokes past the code length', () => {
    expect(normalizeOtpInput('842139071234')).toBe('84213907')
  })
  it('is empty for nothing typed or a non-string', () => {
    expect(normalizeOtpInput('')).toBe('')
    expect(normalizeOtpInput(null)).toBe('')
    expect(normalizeOtpInput(undefined)).toBe('')
  })
})

describe('isCompleteOtp', () => {
  it('is false at six digits — a partial code must not enable the sign-in button', () => {
    expect(isCompleteOtp('842139')).toBe(false)
  })
  it('is true at the full code length', () => {
    expect(isCompleteOtp('84213907')).toBe(true)
  })
  it('is false when empty', () => {
    expect(isCompleteOtp('')).toBe(false)
    expect(isCompleteOtp(null)).toBe(false)
  })
})
