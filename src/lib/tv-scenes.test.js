// src/lib/tv-scenes.test.js
import { describe, it, expect } from 'vitest'
import {
  SCENE_DWELL_MS,
  SCENE_KEYS,
  eligibleScenes,
  sceneAt,
  operatorRenderable,
  operatorImageRef,
  operatorLabel,
} from './tv-scenes.js'

const full = {
  up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD' }],
  earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4 }],
  operator: { source_type: 'storage', source_ref: 'x.png' },
}

// Every operator shape the scene could see, named so a failure says which row broke.
const OPERATOR_MATRIX = {
  'storage image with ref': { source_type: 'storage', source_ref: 'a.png', label: null, template_values: null },
  'url image with ref': { source_type: 'url', source_ref: 'https://example.com/a.png', label: null, template_values: null },
  'storage ref with surrounding whitespace': { source_type: 'storage', source_ref: '  a.png  ', label: null, template_values: null },
  'template row with ref and no label': { source_type: 'template', source_ref: 'x', label: null, template_values: null },
  'template row with ref and label': { source_type: 'template', source_ref: 'x', label: 'Offer', template_values: {} },
  'label only': { source_type: 'template', source_ref: null, label: 'Offer', template_values: null },
  'template_values only': { source_type: 'template', source_ref: null, label: null, template_values: { a: 1 } },
  'neither image nor label': { source_type: 'template', source_ref: null, label: null, template_values: {} },
  'storage whitespace ref and whitespace label': { source_type: 'storage', source_ref: '   ', label: '   ', template_values: null },
  'storage whitespace ref with real label': { source_type: 'storage', source_ref: '   ', label: 'Offer', template_values: null },
  'url whitespace ref with real label': { source_type: 'url', source_ref: '   ', label: 'Offer', template_values: null },
  'source_ref with no source_type': { source_ref: 'a.png', label: null },
  'null operator': null,
  'undefined operator': undefined,
  'non-object operator': 'x',
}

describe('constants', () => {
  it('pins the dwell at exactly 30 seconds', () => {
    expect(SCENE_DWELL_MS).toBe(30000)
  })

  it('pins the rotation order', () => {
    expect(SCENE_KEYS).toEqual(['up-next', 'earned', 'operator'])
  })
})

describe('operatorImageRef', () => {
  it('returns the ref for a storage image', () => {
    expect(operatorImageRef({ source_type: 'storage', source_ref: 'a.png', label: null, template_values: null })).toBe('a.png')
  })

  it('returns the ref for a url image', () => {
    expect(operatorImageRef({ source_type: 'url', source_ref: 'https://example.com/a.png', label: null, template_values: null })).toBe('https://example.com/a.png')
  })

  it('returns the ref with surrounding whitespace trimmed', () => {
    expect(operatorImageRef({ source_type: 'storage', source_ref: '  a.png  ', label: null, template_values: null })).toBe('a.png')
  })

  // Only storage and url draw an image; a ref on a template row is never an image.
  it('is null for a template row even with a ref', () => {
    expect(operatorImageRef({ source_type: 'template', source_ref: 'x', label: null, template_values: null })).toBeNull()
  })

  it('is null for a whitespace-only ref', () => {
    expect(operatorImageRef({ source_type: 'storage', source_ref: '   ', label: null, template_values: null })).toBeNull()
  })

  it('is null for a missing ref', () => {
    expect(operatorImageRef({ source_type: 'storage', source_ref: null, label: null, template_values: null })).toBeNull()
  })

  it('is null for a null or undefined operator', () => {
    expect(operatorImageRef(null)).toBeNull()
    expect(operatorImageRef(undefined)).toBeNull()
  })

  // The motivating case: a whitespace ref must not send the scene down the image branch.
  // The row still appears (it has a label), but it draws the label, never an <img>.
  it('is null for a storage ref that is only whitespace when a label carries the row', () => {
    const op = { source_type: 'storage', source_ref: '   ', label: 'Offer', template_values: null }
    expect(operatorImageRef(op)).toBeNull()
    expect(operatorRenderable(op)).toBe(true)
  })
})

describe('operatorLabel', () => {
  it('returns the label trimmed', () => {
    expect(operatorLabel({ source_type: 'template', source_ref: null, label: '  Open day  ', template_values: null })).toBe('Open day')
  })

  it('is null for a blank, whitespace, missing or non-string label', () => {
    for (const label of ['', '   ', '\n\t', null, undefined, 7, {}]) {
      expect(operatorLabel({ source_type: 'template', source_ref: null, label, template_values: null }), String(label)).toBeNull()
    }
  })

  it('is null for a null, undefined or non-object operator', () => {
    expect(operatorLabel(null)).toBeNull()
    expect(operatorLabel(undefined)).toBeNull()
    expect(operatorLabel('x')).toBeNull()
  })

  // The label is read whatever the source_type: the scene decides the BRANCH
  // with operatorImageRef, and falls back to this when it returns null.
  it('does not depend on source_type', () => {
    expect(operatorLabel({ source_type: 'storage', source_ref: 'a.png', label: 'Offer' })).toBe('Offer')
    expect(operatorLabel({ label: 'Offer' })).toBe('Offer')
  })
})

describe('operatorRenderable', () => {
  it('is true for an image the scene can draw (storage + ref)', () => {
    expect(operatorRenderable({ source_type: 'storage', source_ref: 'a.png', label: null, template_values: null })).toBe(true)
  })

  it('is true for a url image (url + ref)', () => {
    expect(operatorRenderable({ source_type: 'url', source_ref: 'https://example.com/a.png', label: null, template_values: null })).toBe(true)
  })

  // A ref is only drawn as an image for storage/url; on a template row it is dead weight.
  it('is false for a template row with a ref and no label', () => {
    expect(operatorRenderable({ source_type: 'template', source_ref: 'x', label: null, template_values: null })).toBe(false)
  })

  it('is true for a template row whose label carries it', () => {
    expect(operatorRenderable({ source_type: 'template', source_ref: 'x', label: 'Offer', template_values: {} })).toBe(true)
  })

  it('is true for a label-only row', () => {
    expect(operatorRenderable({ source_type: 'template', source_ref: null, label: 'Offer', template_values: null })).toBe(true)
  })

  // template_values alone is not renderable yet, so neither field means false.
  it('is false when neither an image nor a label is present', () => {
    expect(operatorRenderable({ source_type: 'template', source_ref: null, label: null, template_values: {} })).toBe(false)
  })

  it('is false for a whitespace-only ref and label', () => {
    expect(operatorRenderable({ source_type: 'storage', source_ref: '  ', label: '   ', template_values: null })).toBe(false)
  })

  it('is false for null and undefined', () => {
    expect(operatorRenderable(null)).toBe(false)
    expect(operatorRenderable(undefined)).toBe(false)
  })
})

describe('eligibleScenes', () => {
  it('returns every scene that has content, in rotation order', () => {
    expect(eligibleScenes(full)).toEqual(SCENE_KEYS)
  })

  it('skips a scene whose list is empty', () => {
    expect(eligibleScenes({ ...full, earned: [] })).toEqual(['up-next', 'operator'])
  })

  it('skips the operator card when nothing is pushed', () => {
    expect(eligibleScenes({ ...full, operator: null })).toEqual(['up-next', 'earned'])
  })

  it('keeps the operator card when it has an image to show', () => {
    expect(eligibleScenes({ up_next: [], earned: [], operator: { source_type: 'storage', source_ref: 'a.png', label: null, template_values: null } })).toEqual(['operator'])
  })

  it('keeps the operator card when it has a label to show', () => {
    expect(eligibleScenes({ up_next: [], earned: [], operator: { source_type: 'template', source_ref: null, label: 'Offer', template_values: null } })).toEqual(['operator'])
  })

  // template_values alone cannot be drawn, so a row with neither field is not content.
  it('skips an operator row with neither an image nor a label', () => {
    expect(eligibleScenes({ ...full, operator: { source_type: 'template', source_ref: null, label: null, template_values: {} } })).toEqual(['up-next', 'earned'])
  })

  it('skips an operator row whose image and label are empty strings', () => {
    expect(eligibleScenes({ ...full, operator: { source_type: 'storage', source_ref: '', label: '', template_values: null } })).toEqual(['up-next', 'earned'])
  })

  it('skips an operator row whose label is only whitespace', () => {
    expect(eligibleScenes({ ...full, operator: { source_type: 'template', source_ref: null, label: '   ', template_values: null } })).toEqual(['up-next', 'earned'])
  })

  it('skips an operator row whose image is a template ref with no label', () => {
    expect(eligibleScenes({ ...full, operator: { source_type: 'template', source_ref: 'x', label: null, template_values: null } })).toEqual(['up-next', 'earned'])
  })

  // Review Focus 4 — every scene empty must be representable, not a crash.
  it('returns an empty list when nothing has content', () => {
    expect(eligibleScenes({ up_next: [], earned: [], operator: null })).toEqual([])
  })

  it('tolerates a missing or malformed idle block', () => {
    expect(eligibleScenes(null)).toEqual([])
    expect(eligibleScenes(undefined)).toEqual([])
    expect(eligibleScenes({})).toEqual([])
    expect(eligibleScenes({ up_next: 'nope', earned: 7, operator: 'x' })).toEqual([])
  })
})

describe('eligibility and renderability agree', () => {
  it('agrees with operatorRenderable for every operator row, in both directions', () => {
    const outcomes = new Set()
    for (const [name, operator] of Object.entries(OPERATOR_MATRIX)) {
      const inScene = eligibleScenes({ up_next: [], earned: [], operator }).includes('operator')
      expect(inScene, name).toBe(operatorRenderable(operator))
      // And the two things a scene can draw are exactly the two predicates it
      // exposes, so a consumer that branches on them cannot draw a blank.
      expect(inScene, name).toBe(operatorImageRef(operator) !== null || operatorLabel(operator) !== null)
      outcomes.add(inScene)
    }
    // The matrix must cover both outcomes, or the agreement check proves nothing.
    expect(outcomes).toEqual(new Set([true, false]))
  })
})

describe('sceneAt', () => {
  it('holds each scene for SCENE_DWELL_MS then advances', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, 0)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS - 1)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS)).toBe('earned')
    expect(sceneAt(e, SCENE_DWELL_MS * 2)).toBe('operator')
  })

  it('wraps after the last scene', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, SCENE_DWELL_MS * 3)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS * 4)).toBe('earned')
  })

  it('stays put when only one scene is eligible', () => {
    expect(sceneAt(['earned'], 0)).toBe('earned')
    expect(sceneAt(['earned'], SCENE_DWELL_MS * 99)).toBe('earned')
  })

  it('returns null for an empty list', () => {
    expect(sceneAt([], 0)).toBeNull()
    expect(sceneAt([], SCENE_DWELL_MS * 5)).toBeNull()
  })

  // Review Focus 5 — the list shrinking mid-cycle must never index past the end.
  it('never indexes past a list that just shrank', () => {
    const late = SCENE_DWELL_MS * 2 + 10 // was showing index 2 of three
    expect(sceneAt(['up-next', 'earned'], late)).toBe('up-next')
    expect(sceneAt(['up-next'], late)).toBe('up-next')
  })

  it('treats a negative or non-finite elapsed as the first scene', () => {
    const e = ['up-next', 'earned']
    expect(sceneAt(e, -5)).toBe('up-next')
    expect(sceneAt(e, NaN)).toBe('up-next')
  })
})
