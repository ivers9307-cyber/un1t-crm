// OPENWEEK.7 — mig 858: open week reminders claim customer_engagement_nudges.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = join(process.cwd(), 'supabase/migrations/858_open_week_reminder_nudge.sql')
const code = () => sqlCode(readFileSync(FILE, 'utf8')).replace(/\s+/g, ' ')

describe('mig 858 open week reminder nudge type', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('keeps every earlier type and adds open_week_reminder', () => {
    expect(code()).toContain("CHECK (type IN ('streak_at_risk', 'goal_complete', 'tier_up', 'reaction', 'winback', 'class_reminder', 'onboarding_pace', 'open_week_reminder'))")
  })
})
