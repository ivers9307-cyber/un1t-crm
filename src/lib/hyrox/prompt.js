// HYROX-TC.1 — pure prompt builders. Return { system, user } content strings
// for the Anthropic Messages API. The charter is stated as HARD constraints and
// the model is told to self-check against it and return JSON only.
import { HYROX_STATIONS, TIERS, PHASES, DEFAULT_CAP_MINUTES, DEFAULT_CHARTER, MAX_STYLE_EXAMPLES, MAX_EXAMPLE_CHARS } from './constants'

const JSON_ONLY = 'Return ONLY valid JSON matching the requested shape. No prose, no code fences.'
const NO_EMDASH = 'Never use em-dashes or en-dashes in any member-facing string (title, focus, target). Use plain punctuation.'

function styleBlock(charter, houseStyle) {
  const parts = ['WORKOUT DESIGN CHARTER (hard constraints, self-check every session against all three before returning):', charter || DEFAULT_CHARTER]
  if (houseStyle && houseStyle.trim()) {
    parts.push('UN1T HOUSE STYLE (follow this - how this gym actually runs its classes):', houseStyle.trim())
  }
  return parts.join('\n')
}

function examplesBlock(styleExamples) {
  const items = (Array.isArray(styleExamples) ? styleExamples : [])
    .slice(0, MAX_STYLE_EXAMPLES)
    .map((e) => String(e?.text || '').slice(0, MAX_EXAMPLE_CHARS))
    .filter((t) => t.trim())
  if (!items.length) return null
  return ['EXAMPLE SESSIONS in UN1T\'s style - match their structure, format, and coaching voice; do not copy them verbatim:', items.join('\n\n---\n\n')].join('\n\n')
}

export function buildArcPrompt({ weeks = 12, sessionsPerWeek = 2, dial = 'mixed', charter, houseStyle } = {}) {
  const system = [
    'You are a Hyrox strength-and-conditioning coach designing a periodised training block for a gym class.',
    `Design a ${weeks}-week arc across the phases: ${PHASES.join(' -> ')}.`,
    `The Hyrox stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    // Keeping the arc terse is LOAD-BEARING, not cosmetic: a verbose arc (which a
    // detailed charter provokes) overruns the token budget and truncates, so the
    // whole block fails to generate (the 2026-07-23 arc_generation_failed). The
    // arc is only a skeleton; the real detail is written later, per session.
    'This is a HIGH-LEVEL SKELETON only. Do NOT write workouts, movements, sets, reps, or long descriptions here. Each week is one short line of intent; the actual sessions are generated separately afterwards.',
    styleBlock(charter, houseStyle),
    'The charter and house style above govern how the individual SESSIONS are written later. For THIS plan, use them ONLY to steer each week\'s focus. Do not restate or expand them here.',
    'Include benchmark weeks (a Hyrox-style test) so progress is measurable.',
    `Return EXACTLY ${weeks} entries in "plan" (one per week, week_no 1 to ${weeks}) and nothing else. Keep "stimulus" and "progression" to a SHORT phrase of about 5 to 12 words each, never a sentence-long paragraph.`,
    'Output shape, and match this brevity exactly: { "weeks": number, "dial": string, "plan": [ { "week_no": 1, "phase": "base", "stimulus": "Aerobic base and movement quality", "is_benchmark": false, "progression": "Establish baselines at RPE 6" } ] }.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const user = `Design the arc. weeks=${weeks}, sessions_per_week=${sessionsPerWeek}, difficulty_dial=${dial}. Keep every field terse; the detail belongs in the individual sessions, not here.`
  return { system, user }
}

export function buildExpansionPrompt({ week, slot = 1, dial = 'mixed', locationLabel = 'UN1T', charter, houseStyle, styleExamples, autoTuneSignal = null, arcPlan, sessionsPerWeek, prevWeekSummary } = {}) {
  const capLine = `Every session MUST be completable within a ${DEFAULT_CAP_MINUTES}-minute cap by both tiers.`
  const tuneLine = autoTuneSignal
    ? `Auto-tune signal for this week (adjust difficulty accordingly): ${JSON.stringify(autoTuneSignal)}.`
    : 'No auto-tune signal; build difficulty from the phase, stimulus, and dial only.'
  const system = [
    'You are a Hyrox coach writing ONE class session that fits an existing periodised arc.',
    `Scale to exactly these two tiers only, no others: ${TIERS.join(' and ')}. Performance is achievable for a committed regular; Elite stretches the strong.`,
    `Stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    capLine,
    styleBlock(charter, houseStyle),
    ...(examplesBlock(styleExamples) ? [examplesBlock(styleExamples)] : []),
    'BLOCK CONTEXT: you are given the full block plan and this session\'s position below. Place THIS session correctly in that progression: build on the earlier weeks, set up the later ones, do not restart the plan. Label "focus" by the correct block week or a benchmark\'s ordinal; NEVER call a later week "Week 1". Keep the week\'s shared stimulus but make this session DISTINCT in stations, format, or emphasis from the other session(s) that same week.',
    'Output shape: a single JSON session object with these fields and types: { "week_no": number, "slot": number, "phase": string, "focus": short string, "is_benchmark": boolean, "full_session": { "warmup": string, "strength": string, "main": string, "finisher": string, "cues": [string], "why": string }, "board": { "location_label": string, "week_label": string, "focus": short string, "format": short string, "cap_minutes": number, "stations": [ { "name": string, "performance": short string, "elite": short string } ], "target": short string } }.',
    'CRITICAL: every full_session field (warmup, strength, main, finisher, why) is a SINGLE plain-text string written in coaching language, using line breaks for structure where helpful. Do NOT put nested JSON objects, "part_a"/"part_b" keys, or "tiers" objects inside any full_session field. cues is an array of short plain-text strings.',
    'The BOARD is a glanceable TV scoreboard read from across a gym floor, NOT a place for coaching detail. Every board field is a SHORT label or number, never a sentence:',
    '- board.stations[].name: the movement ONLY, 1 to 3 words ("Run", "SkiErg", "Wall Balls", "Farmers Carry"). No protocol, timing, reps, or notes baked into the name.',
    '- board.stations[].performance and board.stations[].elite: a COMPACT target, 12 characters or fewer - a distance, load, reps, or calories, e.g. "400m", "100kg", "9kg x 20", "60 cal", "80m / 20kg". If pace or effort is the only thing separating the tiers, write it compactly like "500m @ 2:25" or "2:25/500m" - never spell out the word "pace", never "RPE" or a coaching note (those belong in full_session). NEVER a coaching sentence, never nested objects.',
    '- board.format: a short workout header, about 5 words max, like "4 ROUNDS FOR TIME", "45 MIN AMRAP", "6 STATIONS x 3 MIN". Not a description of the protocol.',
    '- board.focus: 1 to 4 words ("Aerobic Base", "Threshold Engine", "Benchmark 1").',
    '- board.target: ONE short line, about 8 words max ("RPE 6, finish strong", "sub 32:00").',
    'ALL the how-to (pacing, cues, the reasoning, the prose describing each tier and its numbers) goes in full_session, which ONLY the coach sees, never on the board. If a value reads like a sentence, it belongs in full_session.main, not on the board.',
    'The "why" must state both the training stimulus AND what makes the session engaging.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const weeksTotal = Array.isArray(arcPlan) && arcPlan.length ? arcPlan.length : (week?.week_no || 1)
  let benchmarkTag = ''
  if (week?.is_benchmark && Array.isArray(arcPlan)) {
    const nth = arcPlan.filter((w) => w.is_benchmark && w.week_no <= week.week_no).length
    const total = arcPlan.filter((w) => w.is_benchmark).length
    benchmarkTag = `, benchmark ${nth} of ${total}`
  }
  const planLine = Array.isArray(arcPlan) && arcPlan.length
    ? 'Full block plan in order: ' + arcPlan.map((w) => `week ${w.week_no} (${w.phase}${w.is_benchmark ? ', benchmark' : ''}): ${w.stimulus}`).join('; ') + '.'
    : null
  const user = [
    `Location label: ${locationLabel}. Dial: ${dial}.`,
    `This session is WEEK ${week?.week_no} of ${weeksTotal} (${week?.phase} phase)${benchmarkTag}. It is session ${slot} of ${sessionsPerWeek ?? 1} this week.`,
    `This week's stimulus: ${week?.stimulus}. Progression target: ${week?.progression}.`,
    planLine,
    prevWeekSummary ? `Last week's sessions were: ${prevWeekSummary}. Progress sensibly from them, do not repeat them.` : null,
    tuneLine,
  ].filter(Boolean).join('\n')
  return { system, user }
}
