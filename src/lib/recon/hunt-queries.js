// src/lib/recon/hunt-queries.js
//
// RCOV.P1 — turn one bank line into 2-3 precise Gmail raw queries
// (X-GM-RAW syntax). Demand-driven + precision-over-recall (Richard's
// call): tight amount+window first, then counterparty tokens; never a
// broad sweep. Dates use Gmail's YYYY/MM/DD.
import { addDaysISO } from '@/lib/dublin-time'

// Bank-feed noise that never identifies a supplier.
const NOISE = new Set([
  'card', 'dd', 'sepa', 'ref', 'payment', 'pos', 'vdp', 'vdc',
  'ltd', 'limited', 'the', 'and',
])

export function counterpartyTokens(description) {
  return String(description || '')
    .replace(/[0-9*#]+/g, ' ')
    .split(/[^a-zA-Z]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !NOISE.has(t.toLowerCase()))
    .slice(0, 3)
}

export function gmailDate(isoDate) {
  return String(isoDate).slice(0, 10).replaceAll('-', '/')
}

export function amountVariants(amount) {
  const abs = Math.abs(Number(amount)).toFixed(2)
  return [`"${abs}"`, `"${abs.replace('.', ',')}"`]
}

export function buildHuntQueries(line, windowDays = 45) {
  const from = gmailDate(addDaysISO(String(line.line_date).slice(0, 10), -windowDays))
  const to = gmailDate(addDaysISO(String(line.line_date).slice(0, 10), windowDays))
  const win = `after:${from} before:${to}`
  const tokens = counterpartyTokens(line.description)
  const [dotAmount] = amountVariants(line.amount)
  const queries = []
  queries.push(`${dotAmount} ${win} has:attachment`)
  if (tokens.length > 0) queries.push(`${tokens.join(' ')} ${win} has:attachment`)
  queries.push(`${dotAmount} ${win}`) // body-amount fallback, still windowed
  return queries
}
