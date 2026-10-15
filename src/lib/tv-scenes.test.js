// src/lib/tv-scenes.test.js
import { describe, it, expect } from 'vitest'
import { SCENE_DWELL_MS, SCENE_KEYS, eligibleScenes, sceneAt } from './tv-scenes.js'

const full = {
  up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD' }],
  earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4 }],
  operator: { source_type: 'storage', source_ref: 'x.png' },
}

describe('eligibleScenes', () => {
  it('returns every scene that has content, in rotation order', () => {
    expect(eligibleScenes(full)).toEqual(SCENE_KEYS)
  })

  it('skips a scene whose list is empty', () => {
    expect(eligibleScenes({ ...full, earned: [] })).toEqual(['up-next', 'operator'])
  })

  it('skips the operator card when nothing is pushed', () => {
    expect(eligibleScenes({ ...full, operator: null })).toEqual(['up-next', 'earned'])
  })

  // Review Focus 4 — every scene empty must be representable, not a crash.
  it('returns an empty list when nothing has content', () => {
    expect(eligibleScenes({ up_next: [], earned: [], operator: null })).toEqual([])
  })

  it('tolerates a missing or malformed idle block', () => {
    expect(eligibleScenes(null)).toEqual([])
    expect(eligibleScenes(undefined)).toEqual([])
    expect(eligibleScenes({})).toEqual([])
    expect(eligibleScenes({ up_next: 'nope', earned: 7, operator: 'x' })).toEqual([])
  })
})

describe('sceneAt', () => {
  it('holds each scene for SCENE_DWELL_MS then advances', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, 0)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS - 1)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS)).toBe('earned')
    expect(sceneAt(e, SCENE_DWELL_MS * 2)).toBe('operator')
  })

  it('wraps after the last scene', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, SCENE_DWELL_MS * 3)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS * 4)).toBe('earned')
  })

  it('stays put when only one scene is eligible', () => {
    expect(sceneAt(['earned'], 0)).toBe('earned')
    expect(sceneAt(['earned'], SCENE_DWELL_MS * 99)).toBe('earned')
  })

  it('returns null for an empty list', () => {
    expect(sceneAt([], 0)).toBeNull()
    expect(sceneAt([], SCENE_DWELL_MS * 5)).toBeNull()
  })

  // Review Focus 5 — the list shrinking mid-cycle must never index past the end.
  it('never indexes past a list that just shrank', () => {
    const late = SCENE_DWELL_MS * 2 + 10 // was showing index 2 of three
    expect(sceneAt(['up-next', 'earned'], late)).toBe('up-next')
    expect(sceneAt(['up-next'], late)).toBe('up-next')
  })

  it('treats a negative or non-finite elapsed as the first scene', () => {
    const e = ['up-next', 'earned']
    expect(sceneAt(e, -5)).toBe('up-next')
    expect(sceneAt(e, NaN)).toBe('up-next')
  })
})
