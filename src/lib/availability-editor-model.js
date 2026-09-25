// src/lib/availability-editor-model.js
//
// AVAIL.1b — the web availability editor's decisions, pure, so they can be
// tested without rendering the editor (jsdom cannot see layout, and these are
// not layout). The component (src/components/AvailabilityEditor.jsx) only
// lays out what these say.
//
// A row is the editor's working copy of one rule:
//   { key, kind: 'weekly'|'dated', weekday, start_date, end_date, all_day,
//     start_time, end_time, note, startedOn }
// with '' for an empty input.

import { normaliseAvailability, normaliseRule, ruleKey, describeRule } from '@shared/availability'

// What the PUT body carries for one row: the route's schema, no `kind` (the
// list it sits in says it), times null when the whole day is out.
export function rowToPayload(row) {
  const times = row.all_day
    ? { start_time: null, end_time: null }
    : { start_time: row.start_time || null, end_time: row.end_time || null }
  const note = String(row.note ?? '').trim() || null
  return row.kind === 'weekly'
    ? { weekday: row.weekday, all_day: row.all_day, ...times, note }
    : { start_date: row.start_date, end_date: row.end_date || row.start_date, all_day: row.all_day, ...times, note }
}

// A canonical rule back into the body's shape.
function payloadOf(rule) {
  const common = { all_day: rule.all_day, start_time: rule.start_time, end_time: rule.end_time, note: rule.note }
  return rule.kind === 'weekly'
    ? { weekday: rule.weekday, ...common }
    : { start_date: rule.start_date, end_date: rule.end_date, ...common }
}

// Content AND note: the identity normaliseAvailability de-duplicates on.
const identity = (rule) => `${ruleKey(rule)}|${rule?.note ?? ''}`
const canonicalOf = (row) => normaliseRule({ ...rowToPayload(row), kind: row.kind })

/**
 * What a save sends, and what each sent rule came from.
 *
 * The route answers issues as { path: 'dated.3', message }, where 3 indexes
 * ITS normaliseAvailability() of the body: sorted, exact duplicates dropped.
 * So the body is built from that same canonical form: the server's
 * normalisation of it is then a no-op and its indexes are this function's
 * indexes. `sent[kind][i].rowKeys` are the rows that produced rule i (more
 * than one when the coach typed a duplicate).
 */
export function planSave(rows) {
  const list = rows || []
  const canonical = normaliseAvailability({
    weekly: list.filter((r) => r.kind === 'weekly').map(rowToPayload),
    dated: list.filter((r) => r.kind === 'dated').map(rowToPayload),
  })
  const sentFor = (kind) => canonical[kind].map((rule) => ({
    rule,
    rowKeys: list.filter((r) => r.kind === kind && identity(canonicalOf(r)) === identity(rule)).map((r) => r.key),
  }))
  return {
    body: { weekly: canonical.weekly.map(payloadOf), dated: canonical.dated.map(payloadOf) },
    sent: { weekly: sentFor('weekly'), dated: sentFor('dated') },
  }
}

/**
 * Where each issue of a refused save belongs: under the first row that
 * produced the rule its path indexes (`byRow[rowKey]`), else in the general
 * message. An index with no row still names its rule ("5 Oct, all day: …");
 * a path about a whole list, or none, is said as it came.
 */
export function placeIssues(issues, sent) {
  const byRow = {}
  const general = []
  for (const issue of Array.isArray(issues) ? issues : []) {
    const message = issue?.message || 'This entry could not be saved'
    const m = /^(weekly|dated)\.(\d+)(?:\.|$)/.exec(String(issue?.path ?? ''))
    const entry = m ? sent?.[m[1]]?.[Number(m[2])] : null
    const rowKey = entry?.rowKeys?.[0]
    if (rowKey != null) (byRow[rowKey] ||= []).push(message)
    else if (entry?.rule) general.push(`${describeRule(entry.rule)}: ${message}`)
    else general.push(message)
  }
  return { byRow, general }
}
