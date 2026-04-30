// Irish public (bank) holidays — statutory list per the Public Holidays Act 1973
// (as amended), covering 2025-2030. Each year has the 10 holidays:
//
//   - New Year's Day                        (Jan 1)
//   - St Brigid's Day                       (1st Monday of Feb, or Feb 1 if it falls on a Friday)
//   - St Patrick's Day                      (Mar 17)
//   - Easter Monday                         (Gregorian computus)
//   - May Public Holiday                    (1st Monday of May)
//   - June Public Holiday                   (1st Monday of June)
//   - August Public Holiday                 (1st Monday of August)
//   - October Public Holiday                (last Monday of October)
//   - Christmas Day                         (Dec 25)
//   - St Stephen's Day                      (Dec 26)
//
// Hardcoded so the schedule can highlight holidays without an external API
// dependency. Regenerate when 2030 rolls around.

const STATIC_IRISH_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-02-03', name: "St Brigid's Day" },
  { date: '2025-03-17', name: "St Patrick's Day" },
  { date: '2025-04-21', name: 'Easter Monday' },
  { date: '2025-05-05', name: 'May Public Holiday' },
  { date: '2025-06-02', name: 'June Public Holiday' },
  { date: '2025-08-04', name: 'August Public Holiday' },
  { date: '2025-10-27', name: 'October Public Holiday' },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: "St Stephen's Day" },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-02', name: "St Brigid's Day" },
  { date: '2026-03-17', name: "St Patrick's Day" },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-05-04', name: 'May Public Holiday' },
  { date: '2026-06-01', name: 'June Public Holiday' },
  { date: '2026-08-03', name: 'August Public Holiday' },
  { date: '2026-10-26', name: 'October Public Holiday' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: "St Stephen's Day" },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-02-01', name: "St Brigid's Day" },        // Feb 1 falls on a Monday
  { date: '2027-03-17', name: "St Patrick's Day" },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-05-03', name: 'May Public Holiday' },
  { date: '2027-06-07', name: 'June Public Holiday' },
  { date: '2027-08-02', name: 'August Public Holiday' },
  { date: '2027-10-25', name: 'October Public Holiday' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: "St Stephen's Day" },

  // 2028
  { date: '2028-01-01', name: "New Year's Day" },
  { date: '2028-02-07', name: "St Brigid's Day" },
  { date: '2028-03-17', name: "St Patrick's Day" },
  { date: '2028-04-17', name: 'Easter Monday' },
  { date: '2028-05-01', name: 'May Public Holiday' },
  { date: '2028-06-05', name: 'June Public Holiday' },
  { date: '2028-08-07', name: 'August Public Holiday' },
  { date: '2028-10-30', name: 'October Public Holiday' },
  { date: '2028-12-25', name: 'Christmas Day' },
  { date: '2028-12-26', name: "St Stephen's Day" },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-02-05', name: "St Brigid's Day" },
  { date: '2029-03-17', name: "St Patrick's Day" },
  { date: '2029-04-02', name: 'Easter Monday' },
  { date: '2029-05-07', name: 'May Public Holiday' },
  { date: '2029-06-04', name: 'June Public Holiday' },
  { date: '2029-08-06', name: 'August Public Holiday' },
  { date: '2029-10-29', name: 'October Public Holiday' },
  { date: '2029-12-25', name: 'Christmas Day' },
  { date: '2029-12-26', name: "St Stephen's Day" },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-02-01', name: "St Brigid's Day" },        // Feb 1 falls on a Friday
  { date: '2030-03-17', name: "St Patrick's Day" },
  { date: '2030-04-22', name: 'Easter Monday' },
  { date: '2030-05-06', name: 'May Public Holiday' },
  { date: '2030-06-03', name: 'June Public Holiday' },
  { date: '2030-08-05', name: 'August Public Holiday' },
  { date: '2030-10-28', name: 'October Public Holiday' },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: "St Stephen's Day" },
]

// Each entry from the static list is annotated with `source: 'national'` and
// `country` so the schedule UI can distinguish statutory holidays from custom
// per-location ones (those carry `source: 'custom'`).
const annotate = (country, list) => Object.freeze(
  list.map(h => Object.freeze({ ...h, source: 'national', country }))
)

// Country-keyed registry. Add a new country = add a new entry here.
// Keys are ISO 3166-1 alpha-2 codes (matches locations.country).
const HOLIDAYS_BY_COUNTRY = Object.freeze({
  IE: annotate('IE', STATIC_IRISH_HOLIDAYS),
  // Future: GB, US, DE, etc. Each entry must be sorted ascending by date.
})

/**
 * The set of country codes we have a static holiday list for.
 * Use to show a friendly warning if a location's country isn't covered yet.
 */
export const SUPPORTED_HOLIDAY_COUNTRIES = Object.freeze(Object.keys(HOLIDAYS_BY_COUNTRY))

const COUNTRY_NAMES = Object.freeze({
  IE: 'Ireland',
  GB: 'United Kingdom',
  US: 'United States',
})

/**
 * Lookup the human name of a country code (best-effort). Falls back to
 * the code itself if unknown.
 */
export function countryName(code) {
  return COUNTRY_NAMES[code] || code || ''
}

/**
 * Returns the statutory holidays for the given country falling within the
 * inclusive date range [start, end] (YYYY-MM-DD strings). All inputs
 * optional. If the country has no static list registered, returns an empty
 * array (the schedule still works, just no national-holiday badges).
 *
 * @param {string} [start]   YYYY-MM-DD inclusive lower bound
 * @param {string} [end]     YYYY-MM-DD inclusive upper bound
 * @param {string} [country] ISO 3166-1 alpha-2. Default 'IE'.
 */
export function getStaticHolidays(start, end, country = 'IE') {
  const list = HOLIDAYS_BY_COUNTRY[country]
  if (!list) return []
  if (!start && !end) return list.slice()
  return list.filter(h => {
    if (start && h.date < start) return false
    if (end && h.date > end) return false
    return true
  })
}

/**
 * Merge static national holidays with a list of custom per-location ones.
 * Custom entries are tagged `source: 'custom'` and override the static name
 * if the date matches (gym wants to relabel St Patrick's Day → "Closed all
 * day"). De-duplicated by date.
 *
 * @param {object[]} customList  Each: { id, date, name, location_id }
 * @param {object} [opts]        { start?, end?, country? } — country defaults to 'IE'
 * @returns {object[]}           Sorted ascending by date.
 */
export function mergeHolidays(customList, opts = {}) {
  const { start, end, country = 'IE' } = opts
  const byDate = new Map()
  for (const h of getStaticHolidays(start, end, country)) {
    byDate.set(h.date, h)
  }
  for (const c of customList || []) {
    if (start && c.date < start) continue
    if (end && c.date > end) continue
    byDate.set(c.date, { ...c, source: 'custom' })
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Build a Map<date, holiday> for fast O(1) lookups when rendering a calendar.
 */
export function indexByDate(holidays) {
  const m = new Map()
  for (const h of holidays || []) m.set(h.date, h)
  return m
}
