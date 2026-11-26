// INBOXPERM.1 — the thread header must not crush the name or push Resolve
// outside the header when the contact side panel is open (measured on
// production at 1440 px: the header was 458 px wide, its content 696 px, and
// Resolve lay under the panel where it could not be clicked). Both inboxes'
// headers and their controls groups wrap, the identity block keeps a
// readable minimum, and Snooze and Resolve share one wrapper so they drop to
// the next line together.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', f), 'utf8')
const tagBefore = (src, index) => {
  const start = src.lastIndexOf('<div', index)
  return src.slice(start, src.indexOf('>', start) + 1)
}

for (const file of ['WAInbox.jsx', 'IGInbox.jsx']) {
  describe(`${file} thread header`, () => {
    const src = read(file)
    const snooze = src.indexOf('<SnoozeControl\n')
    const wrapperStart = src.lastIndexOf('{/* INBOXFOLLOW.2 — snooze until a time')
    const resolve = src.indexOf('toggleResolved(conversation)}', snooze)

    it('Snooze and Resolve sit in one non-shrinking wrapper, so they stay together', () => {
      expect(snooze).toBeGreaterThan(-1)
      expect(resolve).toBeGreaterThan(snooze)
      expect(tagBefore(src, wrapperStart)).toMatch(/shrink-0/)
      const between = src.slice(wrapperStart, src.indexOf('</button>', resolve))
      expect(between).not.toMatch(/<\/?div\b/)
      expect(src.slice(src.indexOf('</button>', resolve), src.indexOf('</button>', resolve) + 120)).toMatch(/^<\/button>\s*\)\}\s*<\/div>/)
    })

    it('the header and its controls group wrap, and the identity block keeps a readable minimum', () => {
      // The controls group is the element that holds the wrapper.
      const controls = tagBefore(src, src.lastIndexOf('<div', wrapperStart) - 1)
      expect(controls).toMatch(/flex-wrap/)
      expect(controls).toMatch(/min-w-0/)
      const header = tagBefore(src, src.lastIndexOf('<div className="flex items-center gap-3 min-w-0 flex-1 basis-48"', wrapperStart) - 1)
      expect(header).toMatch(/flex-wrap/)
      expect(header).toMatch(/gap-y-/)
      expect(src).toMatch(/<div className="flex items-center gap-3 min-w-0 flex-1 basis-48">/)
      expect(src).toMatch(/truncate min-w-0 max-w-full/)
    })
  })
}
