// src/lib/person-match.js — duplicate contact candidate detection (PERSON-LINK.2)

import { normalisePhone9, normaliseName } from './person-links.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLASSPASS_STATUS = 'classpass_payg'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isClassPass(c) {
  return c.glofox_membership_status === CLASSPASS_STATUS
}

export function contactName(c) {
  const raw = c.name || `${c.first_name || ''} ${c.last_name || ''}`
  return normaliseName(raw)
}

export function contactPhone9(c) {
  return normalisePhone9(c.phone || c.wa_phone)
}

/**
 * pairKey(id1, id2) → canonical '<min>:<max>' string so A:B === B:A.
 * Sorts the two ids as strings ascending.
 */
export function pairKey(id1, id2) {
  const a = String(id1)
  const b = String(id2)
  return a <= b ? `${a}:${b}` : `${b}:${a}`
}

// ---------------------------------------------------------------------------
// Placeholder phone detection
// ---------------------------------------------------------------------------

/**
 * placeholderPhones(contacts, { threshold = 10 } = {})
 * Returns a Set of normalised phone strings (contactPhone9) that appear on
 * STRICTLY MORE THAN `threshold` contacts across the full contacts array.
 * Catches the ~1,569-contact ClassPass placeholder number and any shared
 * reception / landline numbers.
 */
export function placeholderPhones(contacts, { threshold = 10 } = {}) {
  const counts = new Map()
  for (const c of contacts) {
    const ph = contactPhone9(c)
    if (ph) counts.set(ph, (counts.get(ph) ?? 0) + 1)
  }
  const placeholders = new Set()
  for (const [ph, n] of counts) {
    if (n > threshold) placeholders.add(ph)
  }
  return placeholders
}

// ---------------------------------------------------------------------------
// Confidence ordering helper (for dedup)
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 }

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * detectCandidates(contacts, options)
 *
 * Returns array of { aId, bId, method, confidence, reason } with aId < bId.
 *
 * @param {Array}  contacts              - Full contact array for this location
 * @param {Set}    options.dismissedPairKeys - pairKey strings to skip
 * @param {Map}    options.groupOf       - contactId → groupId (already linked)
 * @param {number} options.placeholderThreshold - threshold for placeholder detection
 */
export function detectCandidates(contacts, {
  dismissedPairKeys = new Set(),
  groupOf = new Map(),
  placeholderThreshold = 10,
} = {}) {
  // Map from pairKey → best candidate so far (for dedup)
  const best = new Map()

  function consider(aId, bId, candidate) {
    const key = pairKey(aId, bId)

    // Drop dismissed pairs
    if (dismissedPairKeys.has(key)) return

    // Drop if both already in the same group
    const gA = groupOf.get(aId)
    const gB = groupOf.get(bId)
    if (gA !== undefined && gB !== undefined && gA === gB) return

    // Dedup: keep the highest-confidence match for this pair
    const existing = best.get(key)
    if (!existing || CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      // Enforce canonical aId < bId
      const [minId, maxId] = String(aId) <= String(bId) ? [aId, bId] : [bId, aId]
      best.set(key, { aId: minId, bId: maxId, ...candidate })
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Phone-based matching (non-ClassPass only)
  // ---------------------------------------------------------------------------

  const placeholders = placeholderPhones(contacts, { threshold: placeholderThreshold })

  // Group non-ClassPass contacts by normalised phone (skip nulls and placeholders)
  const byPhone = new Map()
  for (const c of contacts) {
    if (isClassPass(c)) continue
    const ph = contactPhone9(c)
    if (!ph) continue
    if (placeholders.has(ph)) continue
    if (!byPhone.has(ph)) byPhone.set(ph, [])
    byPhone.get(ph).push(c)
  }

  for (const group of byPhone.values()) {
    const n = group.length
    if (n === 1) continue

    if (n === 2) {
      const [a, b] = group
      const nameA = contactName(a)
      const nameB = contactName(b)
      const sameNonEmptyName = nameA !== '' && nameA === nameB
      if (sameNonEmptyName) {
        consider(a.id, b.id, { method: 'phone', confidence: 'high', reason: 'Same phone and name' })
      } else {
        consider(a.id, b.id, { method: 'phone', confidence: 'medium', reason: 'Same phone, different name' })
      }
    } else {
      // n >= 3: every unordered pair is low-confidence
      const reason = `Phone shared by ${n} accounts`
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          consider(group[i].id, group[j].id, { method: 'phone', confidence: 'low', reason })
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Name-based matching (ClassPass↔real only)
  // ---------------------------------------------------------------------------

  // Index non-ClassPass contacts by normalised name (skip empty)
  const realByName = new Map()
  for (const c of contacts) {
    if (isClassPass(c)) continue
    const nm = contactName(c)
    if (!nm) continue
    if (!realByName.has(nm)) realByName.set(nm, [])
    realByName.get(nm).push(c)
  }

  // For each ClassPass contact with a non-empty name, find real matches
  for (const c of contacts) {
    if (!isClassPass(c)) continue
    const nm = contactName(c)
    if (!nm) continue
    const matches = realByName.get(nm)
    if (!matches || matches.length === 0) continue

    const k = matches.length
    if (k === 1) {
      consider(c.id, matches[0].id, {
        method: 'name',
        confidence: 'high',
        reason: 'ClassPass name matches one member',
      })
    } else {
      const reason = `ClassPass name matches ${k} members`
      for (const m of matches) {
        consider(c.id, m.id, { method: 'name', confidence: 'medium', reason })
      }
    }
  }

  return Array.from(best.values())
}
