// HYROX-TC.1 — domain constants + the operator-editable workout design charter.
// The charter is the default; the generator accepts an override read from
// settings in a later plan (spec §4.4 "operator-editable").

export const HYROX_STATIONS = [
  'SkiErg', 'Sled push', 'Sled pull', 'Burpee broad jump',
  'Row', 'Farmers carry', 'Sandbag lunge', 'Wall balls',
]

export const TIERS = ['performance', 'elite']       // spec: no Foundation
export const PHASES = ['base', 'build', 'peak', 'taper']
export const DIFFICULTY_DIALS = ['beginner_heavy', 'mixed', 'competitive']

export const DEFAULT_CAP_MINUTES = 45

// No em-dashes anywhere the model might echo into member-facing strings
// (estate rule: em-dash = AI tell in customer copy).
export const DEFAULT_CHARTER = [
  'Every session must be tough, challenging, but doable, and always fun.',
  '',
  'Tough and challenging: a real stimulus for the week\'s phase and energy system,',
  'genuine Hyrox work (running plus stations, compromised running), honest intensity,',
  'and week-on-week progressive overload so the block visibly builds. Never a token session.',
  '',
  'But doable: completable inside the 45-minute cap by BOTH tiers; movements that are safe',
  'and coachable for a mixed drop-in class; volume and pacing that let people finish strong,',
  'not get buried. Performance must be achievable for a committed regular; Elite stretches',
  'the strong. Every session names a realistic target or stimulus.',
  '',
  'Always fun: this is the retention lever, so it is non-negotiable. Vary the format and',
  'stations week to week, lean on formats that create energy in the room (partners, relays,',
  'teams, ladders, races against the clock, the occasional novelty station), and keep a',
  'competitive spark. A member should leave wanting the next one.',
].join('\n')

// House-style example limits (HYROX-STYLE): how many/how long examples feed a
// generation, and the max stored so the settings blob can't grow unbounded.
export const MAX_STYLE_EXAMPLES = 3
export const MAX_EXAMPLE_CHARS = 2500
export const MAX_STORED_EXAMPLES = 20
export const MAX_STORED_EXAMPLE_CHARS = 8000 // max length of a stored/pasted example (a full hand-written session)
