// SHELLY.6 — roll a monotonic Wh counter (aenergy.total) into per-local-day
// rows. Pure: no I/O, no clock, no timezone maths.
//
// wh_total is the SUM OF POSITIVE DELTAS, never wh_last - wh_start: the
// counter resets to ~0 on a factory reset and some firmware updates, and can
// roll back a few Wh after a power cut (flash-save lag). A drop to UNDER half
// the previous value is a reset (count the new total from zero, and record
// that it happened); any smaller drop is a rollback (count nothing). A new
// day starts from yesterday's wh_last so the minute that straddles midnight —
// or a whole cron outage — lands in today rather than nowhere.
//
// prevRow = the LATEST shelly_energy_daily row for this device (today or an
// earlier day) or null. Returns the full next row (every NOT NULL column
// present, every numeric a real Number) or null when the sample is unusable.
//
// TWO RULES RUN THROUGH THE FILE, both about a row that is entirely NOT NULL
// with a >= 0 CHECK on every numeric, upserted for the whole location in ONE
// bulk call — so a single NaN, null or string does not spoil one device's
// day, it fails the write for every device at that location:
//
//  1. NOTHING LEAVES HERE UNCOERCED. PostgREST returns numeric(14,3) columns
//     as STRINGS ('1000.000'), so every numeric is re-derived through num()
//     and re-rounded on the way out. `...prevRow` would otherwise hand the
//     upsert back the string it came with.
//
//  2. ABSENT IS NOT ZERO — the same rule status.js is built on, and it is
//     load-bearing here for a different reason. Number() is far too eager to
//     coerce the reading: Number(null), Number(''), Number([]) and
//     Number(false) are all 0, and Number(true) is 1. Testing the result with
//     Number.isFinite therefore ACCEPTS every one of them and mints a row
//     claiming the meter read 0 Wh — which, against a device whose counter
//     is at 50000, is not a missing reading but an apparent factory reset:
//     it books a reset AND (on the next sample) counts the entire counter
//     again as consumption. An unreadable sample must produce no row at all.
//
// THREE OBLIGATIONS ON THE CRON (Task 8):
//   • It must stamp device_id and location_id on EVERY returned row,
//     unconditionally. The continuing-day branch spreads the previous row and
//     so happens to carry them; the new-day branch deliberately does not (it
//     builds a clean literal, so a created_at-like column from yesterday's
//     row cannot be replayed into today's insert). A cron that stamps them
//     only "if missing" writes a NULL device_id on the day rollover.
//   • `localDay` is a CALLER CONTRACT: the LOCATION's day, dayStrInTz(now,
//     tz), as 'YYYY-MM-DD'. It is stamped onto the row verbatim and is half
//     the (device_id, day) primary key. It is not defended here — Postgres
//     rejects a junk date loudly at the upsert, which is a better failure
//     than this file silently dropping samples it was asked to record.
//   • Sample ONLY when the device is online. An offline device holds its last
//     counter value; a stale repeat is harmless (delta 0), but a device that
//     comes back from a factory reset while unsampled is indistinguishable
//     from one that reset a minute ago — which is what `resets` is for.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Numbers only, and only real ones — rule 2. Deliberately the same idiom as
// src/lib/shelly/status.js's num(), duplicated rather than shared because it
// is six lines and status.js does not export it. Numeric strings are accepted
// because that is exactly how PostgREST returns a numeric column.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// A stored numeric column, read back: readable AND non-negative. Every column
// on this table carries a >= 0 CHECK, so a negative value is not a small
// reading, it is a corrupt row — and using one as a baseline OVER-reports
// (total - (-5) books five Wh that never flowed). Reading each column through
// this is what makes every numeric returned below provably finite and >= 0,
// so nothing this file emits can trip the CHECK that produced it.
const wh = (v) => {
  const n = num(v)
  return n !== null && n >= 0 ? n : null
}

// Non-blank strings only. first_sample_at / last_sample_at are NOT NULL
// timestamptz: '' would be rejected by Postgres and undefined would be
// dropped from the JSON body entirely, failing the insert on a missing column
// rather than on the bad value — a much harder error to read.
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)

// numeric(14,3). Rounding on every write keeps binary float drift out of the
// column: 0.1 + (1000.3 - 1000.1) is 0.29999999999993 unrounded, and a day is
// 1440 samples of that. Safe for realistic Wh (x * 1000 stays far inside
// 2^53 for the 11 integer digits the column allows).
const round3 = (n) => Math.round(n * 1000) / 1000

// The stored day as a comparable 'YYYY-MM-DD'. PostgREST returns a `date`
// column as that exact string, so the slice is a no-op on the real shape and
// exists only so a timestamp-shaped ('2026-07-06T00:00:00+00:00') or
// Date-hydrated value does not read as a different day and silently restart
// the day. A Date is resolved by its UTC calendar date — right for the
// midnight-UTC Date a client library mints from a `date`, and not a shape the
// cron can produce anyway.
//
// Unreadable → null → "not today". That direction is chosen deliberately: a
// wrong "new day" under-reports (today reopens from the last counter reading
// and loses only what was banked before), while a wrong "same day" would
// inherit another day's wh_total and over-report consumption that never
// happened today. Under-report, never over-report.
const dayKey = (v) => {
  if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 10)
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10)
  return null
}

export function rollDailyEnergy(prevRow, sample, localDay) {
  // Rule 2: a reading we cannot read is not a reading. Negative is impossible
  // for a lifetime counter, so it is junk too, not a rollback.
  const total = num(sample?.total_wh)
  if (total === null || total < 0) return null
  const at = str(sample?.at)
  if (at === null) return null

  const prev = isObj(prevRow) ? prevRow : null
  // No readable baseline (no row, or a row whose wh_last is junk or negative)
  // means no delta: counting `total` itself would book the device's whole
  // lifetime consumption as today's.
  const prevLast = prev ? wh(prev.wh_last) : null

  let delta = 0
  let reset = 0
  if (prevLast !== null) {
    if (total >= prevLast) delta = total - prevLast
    else if (total < prevLast / 2) { delta = total; reset = 1 }
    // else: rollback — count nothing. The boundary is exclusive, so a drop to
    // EXACTLY half is a rollback, not a reset. Both readings are then treated
    // as real and the halving is simply never counted; calling it a reset
    // would book prevLast/2 Wh of consumption that did not happen.
  }

  // A new day, or the first sample this device has ever produced. wh_start is
  // the last counter reading before the day opened, which after a reset can
  // exceed wh_last — one more reason wh_total is never wh_last - wh_start.
  if (!prev || dayKey(prev.day) !== localDay) {
    return {
      day: localDay,
      wh_start: round3(prevLast ?? total),
      wh_last: round3(total),
      wh_total: round3(delta),
      samples: 1,
      resets: reset,
      first_sample_at: at,
      last_sample_at: at,
    }
  }

  // The day continues. Spreading prev keeps device_id/location_id and any
  // column added later on the round-trip (see the cron's obligations above);
  // every field below overrides it, and `day` is re-stamped canonically so a
  // timestamp-shaped value cannot reach the (device_id, day) upsert key.
  // Junk numerics fall back to 0 rather than propagating NaN: `?? ` does not
  // catch NaN, so `Number(prev.wh_total) + delta` would put the literal NaN
  // into a NOT NULL column and fail the whole location's bulk write.
  return {
    ...prev,
    day: localDay,
    wh_start: round3(wh(prev.wh_start) ?? prevLast ?? total),
    wh_last: round3(total),
    wh_total: round3((wh(prev.wh_total) ?? 0) + delta),
    samples: (wh(prev.samples) ?? 0) + 1,
    resets: (wh(prev.resets) ?? 0) + reset,
    first_sample_at: str(prev.first_sample_at) ?? at,
    last_sample_at: at,
  }
}
