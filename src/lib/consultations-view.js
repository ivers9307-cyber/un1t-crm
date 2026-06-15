// src/lib/consultations-view.js — pure view helpers for the Consultations tab
const STATUS_RANK = { open: 0, achieved: 1, dropped: 2 }
export function sortGoals(goals) {
  return [...(goals || [])].sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (r !== 0) return r
    return String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
}
export function latestScan(scans) {
  if (!scans || scans.length === 0) return null
  return [...scans].sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at)))[0]
}
export function scanSeries(scans, metric) {
  return (scans || [])
    .filter((s) => s[metric] != null)
    .map((s) => ({ x: s.scanned_at, y: Number(s[metric]) }))
    .sort((a, b) => String(a.x).localeCompare(String(b.x)))
}
