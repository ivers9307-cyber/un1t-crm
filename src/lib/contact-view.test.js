import { describe, it, expect } from 'vitest'
import { mergeTimeline, timelineFilterGroup, deriveNeedsAttention } from './contact-view'

describe('mergeTimeline', () => {
  it('merges notes and activities newest-first with type tags', () => {
    const notes = [{ id: 'n1', created_at: '2026-07-10T10:00:00Z', content: 'hello' }]
    const activities = [
      { id: 'a1', created_at: '2026-07-11T10:00:00Z', type: 'booking' },
      { id: 'a2', created_at: '2026-07-09T10:00:00Z', type: null },
    ]
    const tl = mergeTimeline(notes, activities)
    expect(tl.map((t) => t.id)).toEqual(['a1', 'n1', 'a2'])
    // NB: matches the original page.js spread order — the raw activity
    // row wins the `type` key (so type === the activity's own type, not
    // the 'activity' tag). activityType is the reliable discriminator.
    expect(tl[0]).toMatchObject({ type: 'booking', activityType: 'booking' })
    expect(tl[1]).toMatchObject({ type: 'note', activityType: 'note' })
    expect(tl[2].activityType).toBe('task') // null type falls back to task
  })
  it('handles empty inputs', () => {
    expect(mergeTimeline([], [])).toEqual([])
    expect(mergeTimeline(null, undefined)).toEqual([])
  })
})

describe('timelineFilterGroup', () => {
  it('maps activity types to filter pills', () => {
    expect(timelineFilterGroup({ activityType: 'booking' })).toBe('classes')
    expect(timelineFilterGroup({ activityType: 'whatsapp_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'whatsapp_received' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'sms_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'email' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'note' })).toBe('notes')
    expect(timelineFilterGroup({ activityType: 'pipeline' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'task' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'call' })).toBe('system')
  })
})

describe('deriveNeedsAttention', () => {
  const base = { pipeline_stage_slug: 'first_class', trial_credits_remaining: 2, next_class_at: null }
  it('flags funnel contact with credits but no next class', () => {
    const items = deriveNeedsAttention({ contact: base, arrearsCents: 0, openTasks: [] })
    expect(items).toEqual([expect.objectContaining({ key: 'no_next_class', tone: 'danger' })])
  })
  it('does not flag when a next class is booked', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, next_class_at: '2026-07-15T07:00:00Z' }, arrearsCents: 0, openTasks: [],
    })
    expect(items).toEqual([])
  })
  it('does not flag no_next_class off the funnel', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, pipeline_stage_slug: 'member' }, arrearsCents: 0, openTasks: [],
    })
    expect(items).toEqual([])
  })
  it('flags arrears', () => {
    const items = deriveNeedsAttention({ contact: { ...base, next_class_at: 'x' }, arrearsCents: 4900, openTasks: [] })
    expect(items).toEqual([expect.objectContaining({ key: 'arrears', tone: 'danger' })])
  })
  it('flags overdue tasks (due_date <= todayStr)', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, next_class_at: 'x' }, arrearsCents: 0,
      openTasks: [{ id: 't1', subject: 'Call', due_date: '2026-07-10' }], todayStr: '2026-07-13',
    })
    expect(items).toEqual([expect.objectContaining({ key: 'task_overdue', tone: 'warn' })])
  })
  it('skips overdue detection without todayStr', () => {
    const items = deriveNeedsAttention({
      contact: { ...base, next_class_at: 'x' }, arrearsCents: 0,
      openTasks: [{ id: 't1', subject: 'Call', due_date: '2026-07-10' }],
    })
    expect(items).toEqual([])
  })
})
