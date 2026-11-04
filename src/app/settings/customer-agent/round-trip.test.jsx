// @vitest-environment jsdom
//
// MIASETTINGS.1a — the golden round trip for the Mia settings page. Saving with
// no edits must PUT exactly buildSavePayload(loaded settings, initialOverridden),
// and one edit must change exactly one key. It pins today's page; every later
// task of the redesign keeps it green.

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initialOverridden } from '@/lib/agent/settings-overrides'
import { buildSavePayload } from './save-payload'
import {
  STILLORGAN_GET, HATCH_GET, LEGACY_FULL_BLOB_GET, HATCH_NO_BLOB_GET, EDIT_ONE_PER_SECTION,
} from './__fixtures__/agent-settings'
import { renderEditor, lastPutBody, saveNow, editByLabel } from './__fixtures__/harness'

afterEach(() => { cleanup(); delete global.fetch })

// Leaf paths of a PUT body: objects descend (null counts as empty), arrays and
// scalars are leaves. `overridden` is compared apart.
function leaves(body) {
  const out = {}
  const walk = (v, path) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
    } else out[path] = v
  }
  const { overridden: _o, ...rest } = body
  walk(rest, '')
  return out
}
function changedPaths(a, b) {
  const la = leaves(a)
  const lb = leaves(b)
  // A path absent on one side is changed; `undefined` and absent are the same.
  return [...new Set([...Object.keys(la), ...Object.keys(lb)])]
    .filter((p) => JSON.stringify(la[p] ?? null) !== JSON.stringify(lb[p] ?? null))
    .sort()
}

describe('round trip: saving with no edits', () => {
  for (const [name, get] of [['Stillorgan', STILLORGAN_GET], ['Hatch', HATCH_GET], ['legacy full blob', LEGACY_FULL_BLOB_GET], ['Hatch with no blob', HATCH_NO_BLOB_GET]]) {
    it(`${name}: the PUT body equals buildSavePayload of what was loaded`, async () => {
      await renderEditor(get)
      await saveNow()
      expect(lastPutBody()).toEqual(buildSavePayload(get.settings, initialOverridden(get.studio)))
    })
  }
})

describe('round trip: one edit changes one key', () => {
  for (const e of EDIT_ONE_PER_SECTION) {
    it(`${e.section}: editing "${e.label}" changes only ${e.expectKey}`, async () => {
      await renderEditor(HATCH_GET)
      await saveNow()
      const base = lastPutBody()
      cleanup()

      await renderEditor(HATCH_GET)
      await editByLabel(e.label, e.value, { section: e.section })
      await saveNow()
      const edited = lastPutBody()

      expect(changedPaths(base, edited)).toEqual([e.expectKey])
      // Editing an inheritable field makes it the studio's own: it may join
      // `overridden`, and nothing else may.
      const added = edited.overridden.filter((p) => !base.overridden.includes(p))
      expect(added.every((p) => p === e.expectKey)).toBe(true)
      expect(base.overridden.every((p) => edited.overridden.includes(p))).toBe(true)
    })
  }
})
