// C118 TVTEMPLATESTUDIO.1 — the phone's template editor uploaded a new base
// image at the ACTIVE studio even when the template it was editing belongs to
// another studio, so the image landed in the wrong studio's folder (and, with
// MEMBERWRITESWEEP.1f, the save route refuses it). The editor now works at the
// template's own studio.

import { describe, it, expect } from 'vitest'
import { templateStudioId } from './tv-template-studio'

const A = '0a000000-0000-4000-8000-000000000001'
const B = '0b000000-0000-4000-8000-000000000002'

describe('templateStudioId', () => {
  it('an existing template: its own studio, whatever studio is active', () => {
    expect(templateStudioId({ isNew: false, templateLocationId: B, openedAtLocationId: A, activeLocationId: A })).toBe(B)
  })

  it('an existing template not loaded yet: unknown (null), never the active studio', () => {
    expect(templateStudioId({ isNew: false, templateLocationId: null, openedAtLocationId: A, activeLocationId: A })).toBeNull()
  })

  it('a new template: the studio the editor was opened at, even if the active studio changes after', () => {
    expect(templateStudioId({ isNew: true, templateLocationId: null, openedAtLocationId: A, activeLocationId: B })).toBe(A)
  })

  it('a new template opened before the active studio was known: the active studio', () => {
    expect(templateStudioId({ isNew: true, openedAtLocationId: null, activeLocationId: B })).toBe(B)
    expect(templateStudioId({ isNew: true })).toBeNull()
  })
})
