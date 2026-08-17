// Pure presentation helpers for Apple-Health workout detail on a session.
import { formatDistanceKm } from './format.js'
const LABELS = {
  running: 'Run', walking: 'Walk', cycling: 'Ride', indoor_cycling: 'Ride',
  functional_strength_training: 'Strength', traditional_strength_training: 'Strength',
  high_intensity_interval_training: 'HIIT', swimming: 'Swim', rowing: 'Row',
  elliptical: 'Elliptical', yoga: 'Yoga', core_training: 'Core',
}
const ICONS = {
  running: 'run', walking: 'run', cycling: 'bike', indoor_cycling: 'bike',
  functional_strength_training: 'dumbbell', traditional_strength_training: 'dumbbell',
  high_intensity_interval_training: 'flame', swimming: 'swim', rowing: 'row',
}
function titleCase(s) {
  return String(s).split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}
export function workoutLabel(type) {
  if (!type) return 'Workout'
  return LABELS[type] || titleCase(type)
}
export function workoutIcon(type) {
  return (type && ICONS[type]) || 'activity'
}
export function formatPace(secPerKm) {
  if (secPerKm === null || secPerKm === undefined || !Number.isFinite(Number(secPerKm))) return null
  const s = Math.round(Number(secPerKm))
  const m = Math.floor(s / 60)
  const r = String(s % 60).padStart(2, '0')
  return `${m}:${r} /km`
}
// Delegates to formatDistanceKm (format.js) so list and detail agree on precision (2 dp).
export function formatDistance(meters) {
  const km = formatDistanceKm(meters)
  return km != null ? `${km} km` : null
}
// Human duration from seconds: "45s" / "32 min" / "1h 5m" / "2h". Null on bad input.
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '' || !Number.isFinite(Number(seconds))) return null
  const total = Math.round(Number(seconds))
  if (total < 60) return `${total}s`
  const mins = Math.round(total / 60)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
export function sessionDetailChips(session) {
  const chips = []
  const kcal = session?.calories_kcal
  if (kcal !== null && kcal !== undefined && Number.isFinite(Number(kcal))) {
    chips.push({ key: 'calories', label: `${Math.round(Number(kcal))} kcal` })
  }
  const dist = formatDistance(session?.distance_meters)
  if (dist) chips.push({ key: 'distance', label: dist })
  const pace = formatPace(session?.avg_pace_sec_per_km)
  if (pace) chips.push({ key: 'pace', label: pace })
  return chips
}
