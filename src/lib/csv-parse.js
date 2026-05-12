// Minimal RFC 4180-ish CSV parser. Handles:
//   - quoted fields with embedded commas + newlines
//   - escaped quotes ("" → ")
//   - header row → array of objects keyed by lowercased header
//   - tolerates Windows (\r\n), Mac (\r), Unix (\n) line endings
//
// Why inline vs. papaparse: zero-dep, matches the project's
// "small focused helpers" pattern. CSV imports we care about
// (Glofox invoices, future similar) don't need anything fancier.

/**
 * Parse a CSV string into an array of row objects.
 *
 * @param {string} csv
 * @returns {{ headers: string[], rows: object[] }}
 *   headers — original header strings (case-preserved)
 *   rows    — each row as { lowercased_header_no_spaces: value }
 */
export function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) {
    return { headers: [], rows: [] }
  }
  const records = tokenize(csv)
  if (records.length === 0) return { headers: [], rows: [] }
  const headers = records[0]
  const keys = headers.map(normaliseKey)
  const rows = []
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]
    if (cells.length === 1 && cells[0] === '') continue // blank line
    const obj = {}
    for (let j = 0; j < keys.length; j++) {
      obj[keys[j]] = cells[j] ?? ''
    }
    rows.push(obj)
  }
  return { headers, rows }
}

// Lowercase + strip non-alphanumerics so "Member Email" / "member_email"
// / "MEMBER EMAIL " all map to the same key. Operators' CSV exports
// vary — be permissive on input, deterministic on output.
function normaliseKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// State-machine tokenizer. Returns array of records, each an
// array of string cells.
function tokenize(csv) {
  const records = []
  let row = []
  let cell = ''
  let i = 0
  let inQuotes = false
  while (i < csv.length) {
    const ch = csv[i]
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          // escaped quote
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    // Outside quotes
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r') {
      // CRLF or CR-only — both end the row.
      row.push(cell)
      records.push(row)
      row = []
      cell = ''
      i++
      if (csv[i] === '\n') i++ // skip the LF half of CRLF
      continue
    }
    if (ch === '\n') {
      row.push(cell)
      records.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }
  // Trailing cell + row.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    records.push(row)
  }
  return records
}
