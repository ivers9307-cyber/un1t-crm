// FU-COSMETICS (a) — /achievements is the master-only achievements-catalogue
// editor. It used to live inside src/app/(members)/achievements, so the
// (members) hub's HubTabs strip (src/app/(members)/layout.js) rendered
// above it for whichever OTHER tabs the visiting master held perms for —
// contextual chrome with no tab of its own and no link back to this page.
// Moved to a literal src/app/achievements/page.js (URL unchanged — route
// groups are invisible to the router) so it renders chrome-free, same
// precedent as the event check-in subtree and the race-day control console
// documented in that layout's header comment.
//
// No layout-rendering harness exists in this test suite (page tests here
// call the page function directly, never through Next's actual layout
// tree — see settings-tree.test.js / command-palette.test.js), so the
// structural guarantee IS the filesystem placement: this pins it so the
// page can't silently drift back under the (members) group.

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'

const APP = path.resolve(process.cwd(), 'src/app')

describe('FU-COSMETICS — /achievements lives outside the (members) hub group', () => {
  it('the page file exists at the literal src/app/achievements path', () => {
    expect(existsSync(path.join(APP, 'achievements', 'page.js'))).toBe(true)
  })

  it('the page file no longer exists under (members) — guards against re-nesting', () => {
    expect(existsSync(path.join(APP, '(members)', 'achievements', 'page.js'))).toBe(false)
  })
})
