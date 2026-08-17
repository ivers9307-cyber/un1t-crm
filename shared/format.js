// Pure display formatters for champ-app surfaces. No IO.
// heart_rate_sessions.started_at / ended_at are real timestamptz instants
// (from the bridge / providers), so Date parsing + Dublin formatting is correct
// here — unlike bookings, which store wall-clock strings.

const SOURCE_LABELS = {
  ble_bridge: 'In-studio',
  apple_health: 'Apple Health',
  fitbit: 'Fitbit',
  whoop: 'Whoop',
  garmin: 'Garmin',
  manual: 'Manual',
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || 'Session'
}

/** Whole minutes between two ISO instants, minimum 1; null if either is missing. */
export function durationMinutes(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const ms = new Date(endedAt) - new Date(startedAt)
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.round(ms / 60000))
}

/** "Fri, 19 Jun" in Europe/Dublin; '' for empty/invalid input. */
export function sessionDate(startedAt) {
  if (!startedAt) return ''
  try {
    return new Intl.DateTimeFormat('en-IE', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin',
    }).format(new Date(startedAt))
  } catch {
    return ''
  }
}

// Apple HealthKit HKWorkoutActivityType raw integer → member-friendly label.
// Apple Watch / iPhone workouts arrive as the numeric rawValue (e.g. 50), NOT a
// string identifier, so a numeric map is what we need. Values verified against
// Apple's HKWorkoutActivityType enum. Unknown / Other (3000) → "Workout".
const HK_WORKOUT_TYPE_LABELS = {
  1: 'American Football', 2: 'Archery', 3: 'Australian Football', 4: 'Badminton',
  5: 'Baseball', 6: 'Basketball', 7: 'Bowling', 8: 'Boxing', 9: 'Climbing',
  10: 'Cricket', 11: 'Cross Training', 12: 'Curling', 13: 'Cycling', 14: 'Dance',
  15: 'Dance', 16: 'Elliptical', 17: 'Equestrian', 18: 'Fencing', 19: 'Fishing',
  20: 'Functional Strength', 21: 'Golf', 22: 'Gymnastics', 23: 'Handball',
  24: 'Hiking', 25: 'Hockey', 26: 'Hunting', 27: 'Lacrosse', 28: 'Martial Arts',
  29: 'Mind & Body', 30: 'Mixed Cardio', 31: 'Paddle Sports', 32: 'Play',
  33: 'Recovery', 34: 'Racquetball', 35: 'Rowing', 36: 'Rugby', 37: 'Running',
  38: 'Sailing', 39: 'Skating', 40: 'Snow Sports', 41: 'Soccer', 42: 'Softball',
  43: 'Squash', 44: 'Stair Climbing', 45: 'Surfing', 46: 'Swimming',
  47: 'Table Tennis', 48: 'Tennis', 49: 'Track & Field', 50: 'Strength Training',
  51: 'Volleyball', 52: 'Walking', 53: 'Water Fitness', 54: 'Water Polo',
  55: 'Water Sports', 56: 'Wrestling', 57: 'Yoga', 58: 'Barre', 59: 'Core Training',
  60: 'Cross-Country Skiing', 61: 'Downhill Skiing', 62: 'Flexibility', 63: 'HIIT',
  64: 'Jump Rope', 65: 'Kickboxing', 66: 'Pilates', 67: 'Snowboarding', 68: 'Stairs',
  69: 'Step Training', 70: 'Wheelchair Walk', 71: 'Wheelchair Run', 72: 'Tai Chi',
  73: 'Mixed Cardio', 74: 'Hand Cycling', 75: 'Disc Sports', 76: 'Fitness Gaming',
  77: 'Cardio Dance', 78: 'Social Dance', 79: 'Pickleball', 80: 'Cooldown',
  82: 'Swim-Bike-Run', 83: 'Transition', 84: 'Underwater Diving', 3000: 'Workout',
}

/**
 * Readable workout-type label from a stored `workout_type`. Handles the numeric
 * HK rawValue (the common case), a string HK identifier, or a snake_case key.
 * Returns null for empty input so callers can omit the field entirely.
 */
export function workoutTypeLabel(raw) {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (Number.isFinite(n)) return HK_WORKOUT_TYPE_LABELS[n] || 'Workout'
  const s = String(raw).replace(/^HKWorkoutActivityType/, '').replace(/_/g, ' ').trim()
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Workout'
}

/** "5:30" (min:sec) from seconds-per-km; null if missing/invalid. */
export function formatPace(secPerKm) {
  const n = Number(secPerKm)
  if (!Number.isFinite(n) || n <= 0) return null
  // Round the TOTAL seconds first, then split — rounding minutes and
  // seconds independently produces ":60" (e.g. 359.7 → 5:60 instead of
  // 6:00). Mirrors workout-detail.js formatPace.
  const total = Math.round(n)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Kilometres (2 dp) from metres, e.g. "5.20"; null if missing/invalid. */
export function formatDistanceKm(meters) {
  const n = Number(meters)
  if (!Number.isFinite(n) || n <= 0) return null
  return (n / 1000).toFixed(2)
}
