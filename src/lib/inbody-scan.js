// InBody / Lookin'Body measurement mapping (SP2 Phase 2a enrich).
//
// Maps a GetFullInBodyData (or GetInBodyData) response body into the subset of
// columns the `inbody_scans` table tracks. The InBody response uses full field
// names ("PercentBodyFat") or abbreviations ("PBF") depending on the endpoint,
// and exact casing/spacing isn't documented — so we look up each target field
// against a list of candidate keys, normalised to lowercase alphanumerics. The
// caller always also stores the full `raw` JSON, so an unmapped field is never
// lost — just add a candidate here once the real field name is known.

const FIELDS = {
  weight_kg: ['weight', 'wt'],
  pbf_percent: ['percentbodyfat', 'pbf', 'bodyfatpercentage'],
  smm_kg: ['skeletalmusclemass', 'smm'],
  bmi: ['bmi', 'bodymassindex'],
  bmr: ['basalmetabolicrate', 'bmr'],
  body_fat_mass_kg: ['bodyfatmass', 'bfm'],
  inbody_score: ['inbodyscore', 'score'],
}

const normaliseKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '')

// Build a { normalisedKey: value } index from a plain object; empty for any
// non-object (incl. arrays), which yields an all-null result.
function indexByNormalisedKey(raw) {
  const idx = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return idx
  for (const [k, v] of Object.entries(raw)) idx[normaliseKey(k)] = v
  return idx
}

function pickNum(idx, candidates) {
  for (const c of candidates) {
    if (c in idx) {
      const n = parseFloat(idx[c])
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

export function parseFullInBodyData(raw) {
  const idx = indexByNormalisedKey(raw)
  const out = {}
  for (const [col, candidates] of Object.entries(FIELDS)) out[col] = pickNum(idx, candidates)
  return out
}
