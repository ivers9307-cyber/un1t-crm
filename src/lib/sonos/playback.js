// SONOSPLAY.1 — the Sonos playbackState enum, and the two questions the UI
// actually asks of it.
//
// This exists because the control strip shipped comparing against 'PLAYING'
// when Sonos returns 'PLAYBACK_STATE_PLAYING'. The comparison was never true,
// so the pause button never rendered at all — there was only ever a play
// button — and the readout printed the raw enum as "Playback_state_playing".
// One wrong string, two visible bugs, and nothing failed loudly.
//
// The values are Sonos's, verified against the live household: a real
// sonos_schedules.last_state row reads PLAYBACK_STATE_PLAYING. Keeping them
// in one named place, tested, means the next consumer (the mobile strip)
// cannot re-derive them wrong.

export const PLAYBACK_PLAYING = 'PLAYBACK_STATE_PLAYING'
export const PLAYBACK_PAUSED = 'PLAYBACK_STATE_PAUSED'
export const PLAYBACK_IDLE = 'PLAYBACK_STATE_IDLE'
export const PLAYBACK_BUFFERING = 'PLAYBACK_STATE_BUFFERING'

const LABELS = {
  [PLAYBACK_PLAYING]: 'Playing',
  [PLAYBACK_PAUSED]: 'Paused',
  [PLAYBACK_IDLE]: 'Nothing playing',
  [PLAYBACK_BUFFERING]: 'Buffering',
}

// Should the transport offer PAUSE rather than PLAY?
//
// Buffering counts as playing: audio is on its way and the useful action is
// to stop it. Offering "play" to someone watching a group buffer would do
// nothing they want.
export function isPlaying(playbackState) {
  return playbackState === PLAYBACK_PLAYING || playbackState === PLAYBACK_BUFFERING
}

// Operator-readable state. An unknown or missing value degrades to a neutral
// phrase rather than guessing "Playing" — claiming the room is playing when
// we do not know is the kind of small lie that sends someone to look at the
// wrong thing.
export function playbackLabel(playbackState) {
  return LABELS[playbackState] || 'State unknown'
}
