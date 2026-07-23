// HYROX-TC.1 — pure prompt builders. Return { system, user } content strings
// for the Anthropic Messages API. The charter is stated as HARD constraints and
// the model is told to self-check against it and return JSON only.
import { HYROX_STATIONS, TIERS, PHASES, DEFAULT_CAP_MINUTES, DEFAULT_CHARTER } from './constants'

const JSON_ONLY = 'Return ONLY valid JSON matching the requested shape. No prose, no code fences.'
const NO_EMDASH = 'Never use em-dashes or en-dashes in any member-facing string (title, focus, target). Use plain punctuation.'

function charterBlock(charter) {
  return ['WORKOUT DESIGN CHARTER (hard constraints, self-check every session against all three before returning):', charter || DEFAULT_CHARTER].join('\n')
}

export function buildArcPrompt({ weeks = 12, sessionsPerWeek = 2, dial = 'mixed', charter } = {}) {
  const system = [
    'You are a Hyrox strength-and-conditioning coach designing a periodised training block for a gym class.',
    `Design a ${weeks}-week arc across the phases: ${PHASES.join(' -> ')}.`,
    `The Hyrox stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    charterBlock(charter),
    'Include benchmark weeks (a Hyrox-style test) so progress is measurable.',
    'Output shape: { "weeks": number, "dial": string, "plan": [ { "week_no", "phase", "stimulus", "is_benchmark", "progression" } ] }.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const user = `Design the arc. weeks=${weeks}, sessions_per_week=${sessionsPerWeek}, difficulty_dial=${dial}.`
  return { system, user }
}

export function buildExpansionPrompt({ week, slot = 1, dial = 'mixed', locationLabel = 'UN1T', charter, autoTuneSignal = null } = {}) {
  const capLine = `Every session MUST be completable within a ${DEFAULT_CAP_MINUTES}-minute cap by both tiers.`
  const tuneLine = autoTuneSignal
    ? `Auto-tune signal for this week (adjust difficulty accordingly): ${JSON.stringify(autoTuneSignal)}.`
    : 'No auto-tune signal; build difficulty from the phase, stimulus, and dial only.'
  const system = [
    'You are a Hyrox coach writing ONE class session that fits an existing periodised arc.',
    `Scale to exactly these two tiers only, no others: ${TIERS.join(' and ')}. Performance is achievable for a committed regular; Elite stretches the strong.`,
    `Stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    capLine,
    charterBlock(charter),
    'Output shape: a single session object { week_no, slot, phase, focus, is_benchmark, full_session:{warmup,strength,main,finisher,cues[],why}, board:{location_label,week_label,focus,format,cap_minutes,stations:[{name,performance,elite}],target} }.',
    'The "why" must state both the training stimulus AND what makes the session engaging.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const user = [
    `Location label: ${locationLabel}. Dial: ${dial}. Slot: ${slot}.`,
    `Week ${week?.week_no} (${week?.phase}) stimulus: ${week?.stimulus}. Progression target: ${week?.progression}. Benchmark week: ${Boolean(week?.is_benchmark)}.`,
    tuneLine,
  ].join('\n')
  return { system, user }
}
