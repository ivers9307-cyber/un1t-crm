// CLASS-TIMER PR2 — pure, immutable helpers for editing a timer template's
// `structure` (the block list the class-timer engine consumes). Kept separate
// from the engine so the editor's array manipulation is unit-tested without UI.

/** A sensible starting structure for a new template. */
export function emptyStructure() {
  return [{ kind: 'segment', label: 'Get ready', type: 'prep', seconds: 10 }]
}

/** A fresh single-segment block. */
export function newSegment(overrides = {}) {
  return { kind: 'segment', label: 'Segment', type: 'work', seconds: 30, ...overrides }
}

/** A fresh repeat-group block (a "round"), pre-seeded with work/rest. */
export function newRound(overrides = {}) {
  return {
    kind: 'round',
    count: 4,
    segments: [
      { label: 'Work', type: 'work', seconds: 30 },
      { label: 'Rest', type: 'rest', seconds: 15 },
    ],
    ...overrides,
  }
}

export function addBlock(structure, block) {
  return [...structure, block]
}

export function removeBlock(structure, index) {
  return structure.filter((_, i) => i !== index)
}

/** Swap a block up/down; no-op (returns the same array) at the ends. */
export function moveBlock(structure, index, dir) {
  const j = index + (dir === 'up' ? -1 : 1)
  if (j < 0 || j >= structure.length) return structure
  const copy = structure.slice()
  const tmp = copy[index]
  copy[index] = copy[j]
  copy[j] = tmp
  return copy
}

/** Shallow-merge a patch onto one block. */
export function updateBlock(structure, index, patch) {
  return structure.map((b, i) => (i === index ? { ...b, ...patch } : b))
}

/** Append a segment to a round block (no-op on a plain segment). */
export function addRoundSegment(structure, blockIndex, seg) {
  return structure.map((b, i) => (
    i === blockIndex && b.kind === 'round' ? { ...b, segments: [...b.segments, seg] } : b
  ))
}

/** Remove a nested segment from a round block (no-op on a plain segment). */
export function removeRoundSegment(structure, blockIndex, segIndex) {
  return structure.map((b, i) => {
    if (i !== blockIndex || b.kind !== 'round') return b
    return { ...b, segments: b.segments.filter((_, k) => k !== segIndex) }
  })
}

/** Patch one nested segment of a round block (no-op on a plain segment). */
export function updateRoundSegment(structure, blockIndex, segIndex, patch) {
  return structure.map((b, i) => {
    if (i !== blockIndex || b.kind !== 'round') return b
    return { ...b, segments: b.segments.map((s, k) => (k === segIndex ? { ...s, ...patch } : s)) }
  })
}
