// WATPLRESUBMEDIA.1 (C109) — "Edit & resubmit" must send a newly uploaded
// header file, or the resubmit route keeps the old header_media_url and every
// send attaches the old picture. Which fields go is decided by the pure
// resubmitMediaFields (src/lib/template-media.js, tested there); what is
// pinned here, as source, is that the editor's resubmit body carries its
// output. Uploading a file in jsdom needs the Storage client, so this is a
// floor, not proof.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EDITOR = readFileSync(fileURLToPath(new URL('./WATemplateEditor.jsx', import.meta.url)), 'utf8')

describe('WATemplateEditor: Edit & resubmit sends new header media', () => {
  it('builds the resubmit body with resubmitMediaFields', () => {
    const start = EDITOR.indexOf('async function handleResubmit(')
    expect(start).toBeGreaterThan(-1)
    const fn = EDITOR.slice(start, EDITOR.indexOf('\n  }\n', start))
    expect(fn).toContain('/resubmit`')
    expect(fn).toMatch(/\.\.\.resubmitMediaFields\(template, \{ handle: mediaHandle, url: mediaUrl, path: mediaPath \}, headerFormat\)/)
  })
})
