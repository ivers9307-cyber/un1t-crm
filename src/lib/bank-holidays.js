// Static public-holiday lists for the countries UN1T operates in, covering
// 2025-2030. We hard-code rather than hit an external API so the schedule
// stays fast & deterministic. Regenerate when 2030 rolls around (or earlier
// if a country's official calendar changes).
//
// Notes on coverage:
// - Christian fixed dates (Christmas etc.) and civic dates are exact.
// - Western Easter (used by IE, GB, DE, AU, MT) is computed via Gregorian
//   computus. Greek Orthodox Easter (used by CY, EG-Coptic) is via the
//   Julian computus. Both are encoded directly below.
// - Islamic holidays (KW, EG) follow the Hijri lunar calendar so the
//   Gregorian date depends on local moonsighting and can shift +/- 1 day
//   from official announcements. We use the most widely-published dates,
//   and customers can always override with a custom holiday.

// ---------------------------------------------------------------------------
// IRELAND (IE)
// Public Holidays Act 1973 (as amended) — 10 holidays per year.
// ---------------------------------------------------------------------------
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
  { date: '2027-02-01', name: "St Brigid's Day" },
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
  { date: '2030-02-01', name: "St Brigid's Day" },
  { date: '2030-03-17', name: "St Patrick's Day" },
  { date: '2030-04-22', name: 'Easter Monday' },
  { date: '2030-05-06', name: 'May Public Holiday' },
  { date: '2030-06-03', name: 'June Public Holiday' },
  { date: '2030-08-05', name: 'August Public Holiday' },
  { date: '2030-10-28', name: 'October Public Holiday' },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: "St Stephen's Day" },
]

// ---------------------------------------------------------------------------
// UNITED KINGDOM (GB) — England & Wales bank holidays.
// Note: Substitute days are observed when a fixed-date holiday falls on a
// weekend (e.g. 2026 Boxing Day → 28 Dec).
// ---------------------------------------------------------------------------
const STATIC_UK_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-04-21', name: 'Easter Monday' },
  { date: '2025-05-05', name: 'Early May Bank Holiday' },
  { date: '2025-05-26', name: 'Spring Bank Holiday' },
  { date: '2025-08-25', name: 'Summer Bank Holiday' },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: 'Boxing Day' },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-05-04', name: 'Early May Bank Holiday' },
  { date: '2026-05-25', name: 'Spring Bank Holiday' },
  { date: '2026-08-31', name: 'Summer Bank Holiday' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-28', name: 'Boxing Day (substitute)' },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-05-03', name: 'Early May Bank Holiday' },
  { date: '2027-05-31', name: 'Spring Bank Holiday' },
  { date: '2027-08-30', name: 'Summer Bank Holiday' },
  { date: '2027-12-27', name: 'Christmas Day (substitute)' },
  { date: '2027-12-28', name: 'Boxing Day (substitute)' },

  // 2028
  { date: '2028-01-03', name: "New Year's Day (substitute)" },
  { date: '2028-04-14', name: 'Good Friday' },
  { date: '2028-04-17', name: 'Easter Monday' },
  { date: '2028-05-01', name: 'Early May Bank Holiday' },
  { date: '2028-05-29', name: 'Spring Bank Holiday' },
  { date: '2028-08-28', name: 'Summer Bank Holiday' },
  { date: '2028-12-25', name: 'Christmas Day' },
  { date: '2028-12-26', name: 'Boxing Day' },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-03-30', name: 'Good Friday' },
  { date: '2029-04-02', name: 'Easter Monday' },
  { date: '2029-05-07', name: 'Early May Bank Holiday' },
  { date: '2029-05-28', name: 'Spring Bank Holiday' },
  { date: '2029-08-27', name: 'Summer Bank Holiday' },
  { date: '2029-12-25', name: 'Christmas Day' },
  { date: '2029-12-26', name: 'Boxing Day' },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-04-19', name: 'Good Friday' },
  { date: '2030-04-22', name: 'Easter Monday' },
  { date: '2030-05-06', name: 'Early May Bank Holiday' },
  { date: '2030-05-27', name: 'Spring Bank Holiday' },
  { date: '2030-08-26', name: 'Summer Bank Holiday' },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: 'Boxing Day' },
]

// ---------------------------------------------------------------------------
// GERMANY (DE) — Federal/national-level public holidays.
// (State-specific holidays like Reformation Day or Corpus Christi are not
// included; locations can add them as custom entries.)
// ---------------------------------------------------------------------------
const STATIC_GERMAN_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-04-21', name: 'Easter Monday' },
  { date: '2025-05-01', name: 'Labour Day' },
  { date: '2025-05-29', name: 'Ascension Day' },
  { date: '2025-06-09', name: 'Whit Monday' },
  { date: '2025-10-03', name: 'German Unity Day' },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: 'Second Day of Christmas' },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-05-14', name: 'Ascension Day' },
  { date: '2026-05-25', name: 'Whit Monday' },
  { date: '2026-10-03', name: 'German Unity Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Second Day of Christmas' },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-05-06', name: 'Ascension Day' },
  { date: '2027-05-17', name: 'Whit Monday' },
  { date: '2027-10-03', name: 'German Unity Day' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: 'Second Day of Christmas' },

  // 2028
  { date: '2028-01-01', name: "New Year's Day" },
  { date: '2028-04-14', name: 'Good Friday' },
  { date: '2028-04-17', name: 'Easter Monday' },
  { date: '2028-05-01', name: 'Labour Day' },
  { date: '2028-05-25', name: 'Ascension Day' },
  { date: '2028-06-05', name: 'Whit Monday' },
  { date: '2028-10-03', name: 'German Unity Day' },
  { date: '2028-12-25', name: 'Christmas Day' },
  { date: '2028-12-26', name: 'Second Day of Christmas' },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-03-30', name: 'Good Friday' },
  { date: '2029-04-02', name: 'Easter Monday' },
  { date: '2029-05-01', name: 'Labour Day' },
  { date: '2029-05-10', name: 'Ascension Day' },
  { date: '2029-05-21', name: 'Whit Monday' },
  { date: '2029-10-03', name: 'German Unity Day' },
  { date: '2029-12-25', name: 'Christmas Day' },
  { date: '2029-12-26', name: 'Second Day of Christmas' },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-04-19', name: 'Good Friday' },
  { date: '2030-04-22', name: 'Easter Monday' },
  { date: '2030-05-01', name: 'Labour Day' },
  { date: '2030-05-30', name: 'Ascension Day' },
  { date: '2030-06-10', name: 'Whit Monday' },
  { date: '2030-10-03', name: 'German Unity Day' },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: 'Second Day of Christmas' },
]

// ---------------------------------------------------------------------------
// AUSTRALIA (AU) — National-level public holidays only.
// (State holidays like Labour Day, Melbourne Cup, etc. vary by state and
// are left for custom entries.)
// ---------------------------------------------------------------------------
const STATIC_AUSTRALIAN_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-01-27', name: 'Australia Day (observed)' },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-04-19', name: 'Easter Saturday' },
  { date: '2025-04-21', name: 'Easter Monday' },
  { date: '2025-04-25', name: 'Anzac Day' },
  { date: '2025-06-09', name: "King's Birthday" },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: 'Boxing Day' },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-04', name: 'Easter Saturday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-06-08', name: "King's Birthday" },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-28', name: 'Boxing Day (observed)' },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Australia Day' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-27', name: 'Easter Saturday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-04-26', name: 'Anzac Day (observed)' },
  { date: '2027-06-14', name: "King's Birthday" },
  { date: '2027-12-27', name: 'Christmas Day (observed)' },
  { date: '2027-12-28', name: 'Boxing Day (observed)' },

  // 2028
  { date: '2028-01-03', name: "New Year's Day (observed)" },
  { date: '2028-01-26', name: 'Australia Day' },
  { date: '2028-04-14', name: 'Good Friday' },
  { date: '2028-04-15', name: 'Easter Saturday' },
  { date: '2028-04-17', name: 'Easter Monday' },
  { date: '2028-04-25', name: 'Anzac Day' },
  { date: '2028-06-12', name: "King's Birthday" },
  { date: '2028-12-25', name: 'Christmas Day' },
  { date: '2028-12-26', name: 'Boxing Day' },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-01-26', name: 'Australia Day' },
  { date: '2029-03-30', name: 'Good Friday' },
  { date: '2029-03-31', name: 'Easter Saturday' },
  { date: '2029-04-02', name: 'Easter Monday' },
  { date: '2029-04-25', name: 'Anzac Day' },
  { date: '2029-06-11', name: "King's Birthday" },
  { date: '2029-12-25', name: 'Christmas Day' },
  { date: '2029-12-26', name: 'Boxing Day' },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-01-28', name: 'Australia Day (observed)' },
  { date: '2030-04-19', name: 'Good Friday' },
  { date: '2030-04-20', name: 'Easter Saturday' },
  { date: '2030-04-22', name: 'Easter Monday' },
  { date: '2030-04-25', name: 'Anzac Day' },
  { date: '2030-06-10', name: "King's Birthday" },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: 'Boxing Day' },
]

// ---------------------------------------------------------------------------
// KUWAIT (KW) — Public holidays, including major Islamic observances.
// Islamic dates (Eid, Hijri New Year, Mawlid, Israa Mi'raj) follow the Hijri
// lunar calendar — actual dates depend on local moonsighting and may shift
// +/- 1 day from the values below.
// ---------------------------------------------------------------------------
const STATIC_KUWAIT_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-01-27', name: "Israa wal Mi'raj" },
  { date: '2025-02-25', name: 'National Day' },
  { date: '2025-02-26', name: 'Liberation Day' },
  { date: '2025-03-30', name: 'Eid al-Fitr (Day 1)' },
  { date: '2025-03-31', name: 'Eid al-Fitr (Day 2)' },
  { date: '2025-04-01', name: 'Eid al-Fitr (Day 3)' },
  { date: '2025-06-05', name: 'Arafat Day' },
  { date: '2025-06-06', name: 'Eid al-Adha (Day 1)' },
  { date: '2025-06-07', name: 'Eid al-Adha (Day 2)' },
  { date: '2025-06-08', name: 'Eid al-Adha (Day 3)' },
  { date: '2025-06-26', name: 'Islamic New Year' },
  { date: '2025-09-04', name: "Prophet Muhammad's Birthday" },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-16', name: "Israa wal Mi'raj" },
  { date: '2026-02-25', name: 'National Day' },
  { date: '2026-02-26', name: 'Liberation Day' },
  { date: '2026-03-20', name: 'Eid al-Fitr (Day 1)' },
  { date: '2026-03-21', name: 'Eid al-Fitr (Day 2)' },
  { date: '2026-03-22', name: 'Eid al-Fitr (Day 3)' },
  { date: '2026-05-26', name: 'Arafat Day' },
  { date: '2026-05-27', name: 'Eid al-Adha (Day 1)' },
  { date: '2026-05-28', name: 'Eid al-Adha (Day 2)' },
  { date: '2026-05-29', name: 'Eid al-Adha (Day 3)' },
  { date: '2026-06-16', name: 'Islamic New Year' },
  { date: '2026-08-25', name: "Prophet Muhammad's Birthday" },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-05', name: "Israa wal Mi'raj" },
  { date: '2027-02-25', name: 'National Day' },
  { date: '2027-02-26', name: 'Liberation Day' },
  { date: '2027-03-09', name: 'Eid al-Fitr (Day 1)' },
  { date: '2027-03-10', name: 'Eid al-Fitr (Day 2)' },
  { date: '2027-03-11', name: 'Eid al-Fitr (Day 3)' },
  { date: '2027-05-16', name: 'Arafat Day' },
  { date: '2027-05-17', name: 'Eid al-Adha (Day 1)' },
  { date: '2027-05-18', name: 'Eid al-Adha (Day 2)' },
  { date: '2027-05-19', name: 'Eid al-Adha (Day 3)' },
  { date: '2027-06-06', name: 'Islamic New Year' },
  { date: '2027-08-15', name: "Prophet Muhammad's Birthday" },
  { date: '2027-12-25', name: "Israa wal Mi'raj" },

  // 2028
  { date: '2028-01-01', name: "New Year's Day" },
  { date: '2028-02-25', name: 'National Day' },
  { date: '2028-02-26', name: 'Liberation Day (Day 1) / Eid al-Fitr (Day 1)' },
  { date: '2028-02-27', name: 'Eid al-Fitr (Day 2)' },
  { date: '2028-02-28', name: 'Eid al-Fitr (Day 3)' },
  { date: '2028-05-04', name: 'Arafat Day' },
  { date: '2028-05-05', name: 'Eid al-Adha (Day 1)' },
  { date: '2028-05-06', name: 'Eid al-Adha (Day 2)' },
  { date: '2028-05-07', name: 'Eid al-Adha (Day 3)' },
  { date: '2028-05-25', name: 'Islamic New Year' },
  { date: '2028-08-03', name: "Prophet Muhammad's Birthday" },
  { date: '2028-12-14', name: "Israa wal Mi'raj" },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-02-14', name: 'Eid al-Fitr (Day 1)' },
  { date: '2029-02-15', name: 'Eid al-Fitr (Day 2)' },
  { date: '2029-02-16', name: 'Eid al-Fitr (Day 3)' },
  { date: '2029-02-25', name: 'National Day' },
  { date: '2029-02-26', name: 'Liberation Day' },
  { date: '2029-04-23', name: 'Arafat Day' },
  { date: '2029-04-24', name: 'Eid al-Adha (Day 1)' },
  { date: '2029-04-25', name: 'Eid al-Adha (Day 2)' },
  { date: '2029-04-26', name: 'Eid al-Adha (Day 3)' },
  { date: '2029-05-14', name: 'Islamic New Year' },
  { date: '2029-07-23', name: "Prophet Muhammad's Birthday" },
  { date: '2029-12-03', name: "Israa wal Mi'raj" },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-02-04', name: 'Eid al-Fitr (Day 1)' },
  { date: '2030-02-05', name: 'Eid al-Fitr (Day 2)' },
  { date: '2030-02-06', name: 'Eid al-Fitr (Day 3)' },
  { date: '2030-02-25', name: 'National Day' },
  { date: '2030-02-26', name: 'Liberation Day' },
  { date: '2030-04-12', name: 'Arafat Day' },
  { date: '2030-04-13', name: 'Eid al-Adha (Day 1)' },
  { date: '2030-04-14', name: 'Eid al-Adha (Day 2)' },
  { date: '2030-04-15', name: 'Eid al-Adha (Day 3)' },
  { date: '2030-05-03', name: 'Islamic New Year' },
  { date: '2030-07-13', name: "Prophet Muhammad's Birthday" },
  { date: '2030-11-22', name: "Israa wal Mi'raj" },
]

// ---------------------------------------------------------------------------
// MALTA (MT) — Public and national holidays.
// 14 statutory holidays per year (mostly fixed-date Catholic feasts and
// historical anniversaries, plus moveable Good Friday).
// ---------------------------------------------------------------------------
const STATIC_MALTA_HOLIDAYS = [
  // 2025
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2025-03-19', name: 'Feast of St Joseph' },
  { date: '2025-03-31', name: 'Freedom Day' },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-05-01', name: "Workers' Day" },
  { date: '2025-06-07', name: 'Sette Giugno' },
  { date: '2025-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2025-08-15', name: 'Feast of the Assumption' },
  { date: '2025-09-08', name: 'Victory Day' },
  { date: '2025-09-21', name: 'Independence Day' },
  { date: '2025-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2025-12-13', name: 'Republic Day' },
  { date: '2025-12-25', name: 'Christmas Day' },

  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2026-03-19', name: 'Feast of St Joseph' },
  { date: '2026-03-31', name: 'Freedom Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: "Workers' Day" },
  { date: '2026-06-07', name: 'Sette Giugno' },
  { date: '2026-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2026-08-15', name: 'Feast of the Assumption' },
  { date: '2026-09-08', name: 'Victory Day' },
  { date: '2026-09-21', name: 'Independence Day' },
  { date: '2026-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2026-12-13', name: 'Republic Day' },
  { date: '2026-12-25', name: 'Christmas Day' },

  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2027-03-19', name: 'Feast of St Joseph' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-31', name: 'Freedom Day' },
  { date: '2027-05-01', name: "Workers' Day" },
  { date: '2027-06-07', name: 'Sette Giugno' },
  { date: '2027-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2027-08-15', name: 'Feast of the Assumption' },
  { date: '2027-09-08', name: 'Victory Day' },
  { date: '2027-09-21', name: 'Independence Day' },
  { date: '2027-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2027-12-13', name: 'Republic Day' },
  { date: '2027-12-25', name: 'Christmas Day' },

  // 2028
  { date: '2028-01-01', name: "New Year's Day" },
  { date: '2028-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2028-03-19', name: 'Feast of St Joseph' },
  { date: '2028-03-31', name: 'Freedom Day' },
  { date: '2028-04-14', name: 'Good Friday' },
  { date: '2028-05-01', name: "Workers' Day" },
  { date: '2028-06-07', name: 'Sette Giugno' },
  { date: '2028-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2028-08-15', name: 'Feast of the Assumption' },
  { date: '2028-09-08', name: 'Victory Day' },
  { date: '2028-09-21', name: 'Independence Day' },
  { date: '2028-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2028-12-13', name: 'Republic Day' },
  { date: '2028-12-25', name: 'Christmas Day' },

  // 2029
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2029-03-19', name: 'Feast of St Joseph' },
  { date: '2029-03-30', name: 'Good Friday' },
  { date: '2029-03-31', name: 'Freedom Day' },
  { date: '2029-05-01', name: "Workers' Day" },
  { date: '2029-06-07', name: 'Sette Giugno' },
  { date: '2029-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2029-08-15', name: 'Feast of the Assumption' },
  { date: '2029-09-08', name: 'Victory Day' },
  { date: '2029-09-21', name: 'Independence Day' },
  { date: '2029-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2029-12-13', name: 'Republic Day' },
  { date: '2029-12-25', name: 'Christmas Day' },

  // 2030
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-02-10', name: "Feast of St Paul's Shipwreck" },
  { date: '2030-03-19', name: 'Feast of St Joseph' },
  { date: '2030-03-31', name: 'Freedom Day' },
  { date: '2030-04-19', name: 'Good Friday' },
  { date: '2030-05-01', name: "Workers' Day" },
  { date: '2030-06-07', name: 'Sette Giugno' },
  { date: '2030-06-29', name: 'Feast of St Peter and St Paul' },
  { date: '2030-08-15', name: 'Feast of the Assumption' },
  { date: '2030-09-08', name: 'Victory Day' },
  { date: '2030-09-21', name: 'Independence Day' },
  { date: '2030-12-08', name: 'Feast of the Immaculate Conception' },
  { date: '2030-12-13', name: 'Republic Day' },
  { date: '2030-12-25', name: 'Christmas Day' },
]

// ---------------------------------------------------------------------------
// EGYPT (EG) — Public holidays.
// Mix of fixed civic/Coptic dates, Coptic Easter (Julian computus), and
// Islamic moveable feasts. Islamic dates (same caveat as Kuwait) may shift
// +/- 1 day from the Gregorian dates listed here.
// ---------------------------------------------------------------------------
const STATIC_EGYPT_HOLIDAYS = [
  // 2025
  { date: '2025-01-07', name: 'Coptic Christmas' },
  { date: '2025-01-25', name: 'Revolution Day (25 January)' },
  { date: '2025-01-27', name: "Israa wal Mi'raj" },
  { date: '2025-03-30', name: 'Eid al-Fitr (Day 1)' },
  { date: '2025-03-31', name: 'Eid al-Fitr (Day 2)' },
  { date: '2025-04-01', name: 'Eid al-Fitr (Day 3)' },
  { date: '2025-04-21', name: 'Sham El-Nessim' },
  { date: '2025-04-25', name: 'Sinai Liberation Day' },
  { date: '2025-05-01', name: 'Labour Day' },
  { date: '2025-06-05', name: 'Arafat Day' },
  { date: '2025-06-06', name: 'Eid al-Adha (Day 1)' },
  { date: '2025-06-07', name: 'Eid al-Adha (Day 2)' },
  { date: '2025-06-08', name: 'Eid al-Adha (Day 3)' },
  { date: '2025-06-26', name: 'Islamic New Year' },
  { date: '2025-06-30', name: 'June 30 Revolution Day' },
  { date: '2025-07-23', name: 'Revolution Day (23 July)' },
  { date: '2025-09-04', name: "Prophet Muhammad's Birthday" },
  { date: '2025-10-06', name: 'Armed Forces Day' },

  // 2026
  { date: '2026-01-07', name: 'Coptic Christmas' },
  { date: '2026-01-16', name: "Israa wal Mi'raj" },
  { date: '2026-01-25', name: 'Revolution Day (25 January)' },
  { date: '2026-03-20', name: 'Eid al-Fitr (Day 1)' },
  { date: '2026-03-21', name: 'Eid al-Fitr (Day 2)' },
  { date: '2026-03-22', name: 'Eid al-Fitr (Day 3)' },
  { date: '2026-04-13', name: 'Sham El-Nessim' },
  { date: '2026-04-25', name: 'Sinai Liberation Day' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-05-26', name: 'Arafat Day' },
  { date: '2026-05-27', name: 'Eid al-Adha (Day 1)' },
  { date: '2026-05-28', name: 'Eid al-Adha (Day 2)' },
  { date: '2026-05-29', name: 'Eid al-Adha (Day 3)' },
  { date: '2026-06-16', name: 'Islamic New Year' },
  { date: '2026-06-30', name: 'June 30 Revolution Day' },
  { date: '2026-07-23', name: 'Revolution Day (23 July)' },
  { date: '2026-08-25', name: "Prophet Muhammad's Birthday" },
  { date: '2026-10-06', name: 'Armed Forces Day' },

  // 2027
  { date: '2027-01-05', name: "Israa wal Mi'raj" },
  { date: '2027-01-07', name: 'Coptic Christmas' },
  { date: '2027-01-25', name: 'Revolution Day (25 January)' },
  { date: '2027-03-09', name: 'Eid al-Fitr (Day 1)' },
  { date: '2027-03-10', name: 'Eid al-Fitr (Day 2)' },
  { date: '2027-03-11', name: 'Eid al-Fitr (Day 3)' },
  { date: '2027-04-25', name: 'Sinai Liberation Day' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-05-03', name: 'Sham El-Nessim' },
  { date: '2027-05-16', name: 'Arafat Day' },
  { date: '2027-05-17', name: 'Eid al-Adha (Day 1)' },
  { date: '2027-05-18', name: 'Eid al-Adha (Day 2)' },
  { date: '2027-05-19', name: 'Eid al-Adha (Day 3)' },
  { date: '2027-06-06', name: 'Islamic New Year' },
  { date: '2027-06-30', name: 'June 30 Revolution Day' },
  { date: '2027-07-23', name: 'Revolution Day (23 July)' },
  { date: '2027-08-15', name: "Prophet Muhammad's Birthday" },
  { date: '2027-10-06', name: 'Armed Forces Day' },
  { date: '2027-12-25', name: "Israa wal Mi'raj" },

  // 2028
  { date: '2028-01-07', name: 'Coptic Christmas' },
  { date: '2028-01-25', name: 'Revolution Day (25 January)' },
  { date: '2028-02-26', name: 'Eid al-Fitr (Day 1)' },
  { date: '2028-02-27', name: 'Eid al-Fitr (Day 2)' },
  { date: '2028-02-28', name: 'Eid al-Fitr (Day 3)' },
  { date: '2028-04-17', name: 'Sham El-Nessim' },
  { date: '2028-04-25', name: 'Sinai Liberation Day' },
  { date: '2028-05-01', name: 'Labour Day' },
  { date: '2028-05-04', name: 'Arafat Day' },
  { date: '2028-05-05', name: 'Eid al-Adha (Day 1)' },
  { date: '2028-05-06', name: 'Eid al-Adha (Day 2)' },
  { date: '2028-05-07', name: 'Eid al-Adha (Day 3)' },
  { date: '2028-05-25', name: 'Islamic New Year' },
  { date: '2028-06-30', name: 'June 30 Revolution Day' },
  { date: '2028-07-23', name: 'Revolution Day (23 July)' },
  { date: '2028-08-03', name: "Prophet Muhammad's Birthday" },
  { date: '2028-10-06', name: 'Armed Forces Day' },
  { date: '2028-12-14', name: "Israa wal Mi'raj" },

  // 2029
  { date: '2029-01-07', name: 'Coptic Christmas' },
  { date: '2029-01-25', name: 'Revolution Day (25 January)' },
  { date: '2029-02-14', name: 'Eid al-Fitr (Day 1)' },
  { date: '2029-02-15', name: 'Eid al-Fitr (Day 2)' },
  { date: '2029-02-16', name: 'Eid al-Fitr (Day 3)' },
  { date: '2029-04-09', name: 'Sham El-Nessim' },
  { date: '2029-04-23', name: 'Arafat Day' },
  { date: '2029-04-24', name: 'Eid al-Adha (Day 1)' },
  { date: '2029-04-25', name: 'Eid al-Adha (Day 2) / Sinai Liberation Day' },
  { date: '2029-04-26', name: 'Eid al-Adha (Day 3)' },
  { date: '2029-05-01', name: 'Labour Day' },
  { date: '2029-05-14', name: 'Islamic New Year' },
  { date: '2029-06-30', name: 'June 30 Revolution Day' },
  { date: '2029-07-22', name: "Prophet Muhammad's Birthday" },
  { date: '2029-07-23', name: 'Revolution Day (23 July)' },
  { date: '2029-10-06', name: 'Armed Forces Day' },
  { date: '2029-12-03', name: "Israa wal Mi'raj" },

  // 2030
  { date: '2030-01-07', name: 'Coptic Christmas' },
  { date: '2030-01-25', name: 'Revolution Day (25 January)' },
  { date: '2030-02-04', name: 'Eid al-Fitr (Day 1)' },
  { date: '2030-02-05', name: 'Eid al-Fitr (Day 2)' },
  { date: '2030-02-06', name: 'Eid al-Fitr (Day 3)' },
  { date: '2030-04-12', name: 'Arafat Day' },
  { date: '2030-04-13', name: 'Eid al-Adha (Day 1)' },
  { date: '2030-04-14', name: 'Eid al-Adha (Day 2)' },
  { date: '2030-04-15', name: 'Eid al-Adha (Day 3)' },
  { date: '2030-04-25', name: 'Sinai Liberation Day' },
  { date: '2030-04-29', name: 'Sham El-Nessim' },
  { date: '2030-05-01', name: 'Labour Day' },
  { date: '2030-05-03', name: 'Islamic New Year' },
  { date: '2030-06-30', name: 'June 30 Revolution Day' },
  { date: '2030-07-13', name: "Prophet Muhammad's Birthday" },
  { date: '2030-07-23', name: 'Revolution Day (23 July)' },
  { date: '2030-10-06', name: 'Armed Forces Day' },
  { date: '2030-11-22', name: "Israa wal Mi'raj" },
]

// ---------------------------------------------------------------------------
// CYPRUS (CY) — Public holidays.
// Greek Orthodox Easter is computed via the Julian computus and differs from
// Western Easter in most years. 2025 is the exception (both fall on Apr 20).
// ---------------------------------------------------------------------------
const STATIC_CYPRUS_HOLIDAYS = [
  // 2025  (Orthodox Easter: Apr 20)
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-01-06', name: 'Epiphany' },
  { date: '2025-03-03', name: 'Green Monday' },
  { date: '2025-03-25', name: 'Greek Independence Day' },
  { date: '2025-04-01', name: 'Cyprus National Day' },
  { date: '2025-04-18', name: 'Good Friday (Orthodox)' },
  { date: '2025-04-21', name: 'Easter Monday (Orthodox)' },
  { date: '2025-04-22', name: 'Easter Tuesday (Orthodox)' },
  { date: '2025-05-01', name: 'Labour Day' },
  { date: '2025-06-09', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2025-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2025-10-01', name: 'Cyprus Independence Day' },
  { date: '2025-10-28', name: 'Ohi Day' },
  { date: '2025-12-24', name: 'Christmas Eve' },
  { date: '2025-12-25', name: 'Christmas Day' },
  { date: '2025-12-26', name: 'Boxing Day' },

  // 2026  (Orthodox Easter: Apr 12)
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-06', name: 'Epiphany' },
  { date: '2026-02-23', name: 'Green Monday' },
  { date: '2026-03-25', name: 'Greek Independence Day' },
  { date: '2026-04-01', name: 'Cyprus National Day' },
  { date: '2026-04-10', name: 'Good Friday (Orthodox)' },
  { date: '2026-04-13', name: 'Easter Monday (Orthodox)' },
  { date: '2026-04-14', name: 'Easter Tuesday (Orthodox)' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-06-01', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2026-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2026-10-01', name: 'Cyprus Independence Day' },
  { date: '2026-10-28', name: 'Ohi Day' },
  { date: '2026-12-24', name: 'Christmas Eve' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },

  // 2027  (Orthodox Easter: May 2)
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-06', name: 'Epiphany' },
  { date: '2027-03-15', name: 'Green Monday' },
  { date: '2027-03-25', name: 'Greek Independence Day' },
  { date: '2027-04-01', name: 'Cyprus National Day' },
  { date: '2027-04-30', name: 'Good Friday (Orthodox)' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-05-03', name: 'Easter Monday (Orthodox)' },
  { date: '2027-05-04', name: 'Easter Tuesday (Orthodox)' },
  { date: '2027-06-21', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2027-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2027-10-01', name: 'Cyprus Independence Day' },
  { date: '2027-10-28', name: 'Ohi Day' },
  { date: '2027-12-24', name: 'Christmas Eve' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: 'Boxing Day' },

  // 2028  (Orthodox Easter: Apr 16)
  { date: '2028-01-01', name: "New Year's Day" },
  { date: '2028-01-06', name: 'Epiphany' },
  { date: '2028-02-28', name: 'Green Monday' },
  { date: '2028-03-25', name: 'Greek Independence Day' },
  { date: '2028-04-01', name: 'Cyprus National Day' },
  { date: '2028-04-14', name: 'Good Friday (Orthodox)' },
  { date: '2028-04-17', name: 'Easter Monday (Orthodox)' },
  { date: '2028-04-18', name: 'Easter Tuesday (Orthodox)' },
  { date: '2028-05-01', name: 'Labour Day' },
  { date: '2028-06-05', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2028-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2028-10-01', name: 'Cyprus Independence Day' },
  { date: '2028-10-28', name: 'Ohi Day' },
  { date: '2028-12-24', name: 'Christmas Eve' },
  { date: '2028-12-25', name: 'Christmas Day' },
  { date: '2028-12-26', name: 'Boxing Day' },

  // 2029  (Orthodox Easter: Apr 8)
  { date: '2029-01-01', name: "New Year's Day" },
  { date: '2029-01-06', name: 'Epiphany' },
  { date: '2029-02-19', name: 'Green Monday' },
  { date: '2029-03-25', name: 'Greek Independence Day' },
  { date: '2029-04-01', name: 'Cyprus National Day' },
  { date: '2029-04-06', name: 'Good Friday (Orthodox)' },
  { date: '2029-04-09', name: 'Easter Monday (Orthodox)' },
  { date: '2029-04-10', name: 'Easter Tuesday (Orthodox)' },
  { date: '2029-05-01', name: 'Labour Day' },
  { date: '2029-05-28', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2029-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2029-10-01', name: 'Cyprus Independence Day' },
  { date: '2029-10-28', name: 'Ohi Day' },
  { date: '2029-12-24', name: 'Christmas Eve' },
  { date: '2029-12-25', name: 'Christmas Day' },
  { date: '2029-12-26', name: 'Boxing Day' },

  // 2030  (Orthodox Easter: Apr 28)
  { date: '2030-01-01', name: "New Year's Day" },
  { date: '2030-01-06', name: 'Epiphany' },
  { date: '2030-03-11', name: 'Green Monday' },
  { date: '2030-03-25', name: 'Greek Independence Day' },
  { date: '2030-04-01', name: 'Cyprus National Day' },
  { date: '2030-04-26', name: 'Good Friday (Orthodox)' },
  { date: '2030-04-29', name: 'Easter Monday (Orthodox)' },
  { date: '2030-04-30', name: 'Easter Tuesday (Orthodox)' },
  { date: '2030-05-01', name: 'Labour Day' },
  { date: '2030-06-17', name: 'Kataklysmos / Holy Spirit Day' },
  { date: '2030-08-15', name: 'Assumption of the Virgin Mary' },
  { date: '2030-10-01', name: 'Cyprus Independence Day' },
  { date: '2030-10-28', name: 'Ohi Day' },
  { date: '2030-12-24', name: 'Christmas Eve' },
  { date: '2030-12-25', name: 'Christmas Day' },
  { date: '2030-12-26', name: 'Boxing Day' },
]

// Each entry from the static list is annotated with `source: 'national'` and
// `country` so the schedule UI can distinguish statutory holidays from custom
// per-location ones (those carry `source: 'custom'`).
//
// Several countries have rare collisions (e.g. EG 2029-04-25 = Eid al-Adha
// Day 2 + Sinai Liberation Day, KW 2028-02-26 = Liberation Day + Eid al-Fitr).
// The merge step keys by date so a single day will only render once with the
// last-defined name; we encode the joint name inline above. We de-dupe here
// with a Map keyed by date so the `length` of the resulting array equals the
// number of unique calendar days.
const annotate = (country, list) => {
  const byDate = new Map()
  for (const h of list) byDate.set(h.date, { ...h, source: 'national', country })
  return Object.freeze(
    Array.from(byDate.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(Object.freeze)
  )
}

// Country-keyed registry. Add a new country = add a new entry here.
// Keys are ISO 3166-1 alpha-2 codes (matches locations.country).
const HOLIDAYS_BY_COUNTRY = Object.freeze({
  IE: annotate('IE', STATIC_IRISH_HOLIDAYS),
  GB: annotate('GB', STATIC_UK_HOLIDAYS),
  DE: annotate('DE', STATIC_GERMAN_HOLIDAYS),
  AU: annotate('AU', STATIC_AUSTRALIAN_HOLIDAYS),
  KW: annotate('KW', STATIC_KUWAIT_HOLIDAYS),
  MT: annotate('MT', STATIC_MALTA_HOLIDAYS),
  EG: annotate('EG', STATIC_EGYPT_HOLIDAYS),
  CY: annotate('CY', STATIC_CYPRUS_HOLIDAYS),
})

/**
 * The set of country codes we have a static holiday list for.
 * Use to show a friendly warning if a location's country isn't covered yet.
 */
export const SUPPORTED_HOLIDAY_COUNTRIES = Object.freeze(Object.keys(HOLIDAYS_BY_COUNTRY))

const COUNTRY_NAMES = Object.freeze({
  IE: 'Ireland',
  GB: 'United Kingdom',
  DE: 'Germany',
  AU: 'Australia',
  KW: 'Kuwait',
  MT: 'Malta',
  EG: 'Egypt',
  CY: 'Cyprus',
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
