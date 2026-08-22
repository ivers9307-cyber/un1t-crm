import { describe, it, expect } from 'vitest'
import {
  isPlaying, playbackLabel,
  PLAYBACK_PLAYING, PLAYBACK_PAUSED, PLAYBACK_IDLE, PLAYBACK_BUFFERING,
} from './playback'

describe('the Sonos playbackState enum', () => {
  it('uses the values Sonos actually sends, not shortened ones', () => {
    // The shipped bug: the control strip compared against 'PLAYING'. Sonos
    // sends 'PLAYBACK_STATE_PLAYING', so the comparison was never true and
    // the pause button never rendered. Pin the real strings.
    expect(PLAYBACK_PLAYING).toBe('PLAYBACK_STATE_PLAYING')
    expect(PLAYBACK_PAUSED).toBe('PLAYBACK_STATE_PAUSED')
    expect(PLAYBACK_IDLE).toBe('PLAYBACK_STATE_IDLE')
    expect(PLAYBACK_BUFFERING).toBe('PLAYBACK_STATE_BUFFERING')
  })

  it('rejects the shortened form outright', () => {
    // If someone reintroduces the bug by "simplifying" the enum, this fails.
    expect(isPlaying('PLAYING')).toBe(false)
    expect(playbackLabel('PLAYING')).toBe('State unknown')
  })
})

describe('isPlaying', () => {
  it('is true while playing', () => {
    expect(isPlaying(PLAYBACK_PLAYING)).toBe(true)
  })

  it('is true while buffering, because the useful action is still to stop it', () => {
    expect(isPlaying(PLAYBACK_BUFFERING)).toBe(true)
  })

  it('is false when paused or idle', () => {
    expect(isPlaying(PLAYBACK_PAUSED)).toBe(false)
    expect(isPlaying(PLAYBACK_IDLE)).toBe(false)
  })

  it('is false for a missing or unknown state rather than throwing', () => {
    expect(isPlaying(null)).toBe(false)
    expect(isPlaying(undefined)).toBe(false)
    expect(isPlaying('')).toBe(false)
    expect(isPlaying('SOMETHING_NEW_FROM_SONOS')).toBe(false)
  })
})

describe('playbackLabel', () => {
  it('renders each state in operator language, never the raw enum', () => {
    expect(playbackLabel(PLAYBACK_PLAYING)).toBe('Playing')
    expect(playbackLabel(PLAYBACK_PAUSED)).toBe('Paused')
    expect(playbackLabel(PLAYBACK_IDLE)).toBe('Nothing playing')
    expect(playbackLabel(PLAYBACK_BUFFERING)).toBe('Buffering')
  })

  it('never leaks an underscore-shaped enum into the UI', () => {
    // The shipped bug rendered "Playback_state_playing" on screen.
    for (const s of [PLAYBACK_PLAYING, PLAYBACK_PAUSED, PLAYBACK_IDLE, PLAYBACK_BUFFERING]) {
      expect(playbackLabel(s)).not.toContain('_')
      expect(playbackLabel(s)).not.toMatch(/playback/i)
    }
  })

  it('does not claim the room is playing when the state is unknown', () => {
    // The old fallback was literally 'Playing', which is a small lie that
    // sends an operator to look at the wrong thing.
    expect(playbackLabel(null)).toBe('State unknown')
    expect(playbackLabel(undefined)).toBe('State unknown')
    expect(playbackLabel('SOMETHING_NEW_FROM_SONOS')).toBe('State unknown')
  })
})
