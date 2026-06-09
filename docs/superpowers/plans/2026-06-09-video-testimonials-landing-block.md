# Video Testimonials Landing-Page Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `video_testimonials` landing-page block that shows up to 3 portrait member videos which load near-instantly (poster image + tap-to-play, sound on).

**Architecture:** A new block type in the existing factory/registry (`src/lib/landing-page-blocks.js`), a public renderer that shows a poster `<img>` + play button and only mounts a `<video>` on tap (a `'use client'` widget because the pure `BlockRenderers` components can't hold state), an auto-poster-capture helper in `src/lib/landing-media-upload.js`, and a form editor panel in `LandingPageSettingsForm.jsx` that uploads each clip and auto-generates its poster from the first frame. Reuses `uploadLandingMedia`; no migration, no new API route, no new permission key.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind (public landing pages are dark — `bg-black`/`text-white`; the CRM editor uses the inverted `un1t-*` light tokens), Vitest, Zod, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-09-video-testimonials-landing-block-design.md`

**Key facts confirmed by reading the code (don't re-derive):**
- `BlockBaseSchema` in `landing-page-blocks.js` is `.passthrough()` and only validates `id` + `type: z.enum(BLOCK_TYPES.map(t => t.type))`. **Adding the type to `BLOCK_TYPES` auto-makes the schema accept it** — there's no per-type field validation to add.
- `defaultBlocks()` is the first-open starter set. The new block is **opt-in** (like `gallery`/`embed`/`reviews`) — do NOT add it there.
- `BlockRenderers.jsx` components are **pure (no hooks)** so they render on server (public page) and client (edit iframe). Tap-to-play needs `useState`, so it lives in a separate `'use client'` widget that the pure block renderer embeds — exactly how `LeadFormBlock` embeds `WaitlistWidget`.
- The public page renders every block through the default export `BlockRenderer` (the `switch`), so a new `case` is picked up by both the live page and the edit iframe automatically.
- `LandingPageSettingsForm.jsx` is the form editor. `BlockEditPanel` (line ~622) dispatches per-type panels. `MediaSlot` (line ~1049) is the reusable upload tile (`kind: 'image'|'video'`). `uploadMedia({file, kind, key})` (line ~268) wraps `uploadLandingMedia` with per-key spinner/error state. `summaryFor(block)` (line ~602) is the collapsed-card summary line.
- `uploadLandingMedia({ file, locationId, kind })` already handles `kind:'video'` (direct-to-storage signed-URL PUT, 25MB/MP4·WebM) and `kind:'image'` (canvas downscale + POST).

---

### Task 1: Block factory, registry entry, and tests

**Files:**
- Modify: `src/lib/landing-page-blocks.js` (add factory near the other `*_DEFAULT` consts ~line 119; add registry row in `BLOCK_TYPES` ~line 142)
- Test: `src/lib/landing-page-blocks.test.js` (append a describe block)

- [ ] **Step 1: Write the failing test**

Append to the end of `src/lib/landing-page-blocks.test.js`:

```js
describe('video_testimonials block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    const meta = BLOCK_TYPES.find((t) => t.type === 'video_testimonials')
    expect(meta).toBeTruthy()
    expect(meta.label).toBe('Video testimonials')
  })

  it('factory produces the expected default shape', () => {
    const b = newBlockOfType('video_testimonials')
    expect(b.type).toBe('video_testimonials')
    expect(typeof b.id).toBe('string')
    expect(b.id.length).toBeGreaterThan(0)
    expect(typeof b.title).toBe('string')
    expect(b.title.length).toBeGreaterThan(0)
    expect(Array.isArray(b.items)).toBe(true)
    expect(b.items).toHaveLength(0)
  })

  it('validates through BlocksArraySchema (empty + populated)', () => {
    expect(BlocksArraySchema.safeParse([newBlockOfType('video_testimonials')]).success).toBe(true)
    const populated = {
      id: 'v1',
      type: 'video_testimonials',
      title: 'Hear from our members',
      items: [{ video_url: 'https://x/v.mp4', poster_url: 'https://x/p.jpg', name: 'Sarah' }],
    }
    expect(BlocksArraySchema.safeParse([populated]).success).toBe(true)
  })

  it('is NOT in the default starter set (opt-in like gallery)', () => {
    expect(defaultBlocks().some((b) => b.type === 'video_testimonials')).toBe(false)
  })

  it('blocksOrDefault keeps a saved video_testimonials block', () => {
    const saved = [{ id: 'x', type: 'video_testimonials', items: [] }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: FAIL — `newBlockOfType('video_testimonials')` throws `Unknown block type`, and `BLOCK_TYPES.find(...)` is `undefined`.

- [ ] **Step 3: Add the factory**

In `src/lib/landing-page-blocks.js`, add this const immediately after `REVIEWS_DEFAULT` (the last `*_DEFAULT`, ~line 126):

```js
const VIDEO_TESTIMONIALS_DEFAULT = () => ({
  id:    newBlockId(),
  type:  'video_testimonials',
  title: 'Hear from our members',
  // up to 3 × { video_url, poster_url, name } — added by the editor on upload
  items: [],
})
```

- [ ] **Step 4: Register it**

In the `BLOCK_TYPES` array, add this row right after the `reviews` row (~line 142, keep alignment loose — prettier isn't enforced on this file):

```js
  { type: 'video_testimonials', label: 'Video testimonials', description: 'Up to 3 portrait member videos. Poster image, tap to play.', factory: VIDEO_TESTIMONIALS_DEFAULT },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: PASS (the existing `newBlockOfType` "creates each registered type" test also now exercises the new type).

- [ ] **Step 6: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "feat(landing): video_testimonials block factory + registry"
```

---

### Task 2: `captureVideoPoster` helper

Grabs the first frame of a local video `File` and returns a JPEG `File` to use as the poster. Captures from the **local** blob (no CORS). Resolves `null` on any failure so the caller degrades gracefully.

**Files:**
- Modify: `src/lib/landing-media-upload.js` (add an exported function; the file is browser-only and already uses `<canvas>`)
- Test: `src/lib/landing-media-upload.test.js` (append a describe block — only the non-DOM guard is unit-tested)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/landing-media-upload.test.js`:

```js
import { captureVideoPoster } from './landing-media-upload.js'

describe('captureVideoPoster', () => {
  it('resolves null for a non-video file without touching the DOM', async () => {
    const notAVideo = { name: 'photo.jpg', type: 'image/jpeg' }
    await expect(captureVideoPoster(notAVideo)).resolves.toBeNull()
  })
  it('resolves null for a missing file', async () => {
    await expect(captureVideoPoster(null)).resolves.toBeNull()
  })
})
```

> Note: the actual frame-grab path needs a real `<video>` decode + `<canvas>` and is not meaningfully testable under jsdom — it's covered by the manual verification in Task 5. The unit test pins only the early-return guard (the part that can regress silently). If the test file already has top-of-file imports, add `captureVideoPoster` to the existing `import { … } from './landing-media-upload.js'` line instead of adding a second import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/landing-media-upload.test.js`
Expected: FAIL — `captureVideoPoster` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/lib/landing-media-upload.js` (anywhere at module top level — e.g. just below the `uploadVideoDirect` function, before `parseUploadResponse`):

```js
/**
 * Capture the first frame of a LOCAL video File as a JPEG poster File.
 * Reads the blob via an object URL (no CORS — the file isn't uploaded
 * yet), seeks just past 0 to avoid an all-black opening frame, draws to
 * a canvas at the video's natural size, and exports a JPEG. Browser-only
 * (uses <video>/<canvas>). Resolves null on a non-video input or any
 * decode/seek/encode failure so the caller can save the clip with no
 * poster and degrade gracefully.
 *
 * @param {File|{type?:string}} file
 * @returns {Promise<File|null>}
 */
export async function captureVideoPoster(file) {
  if (!file || !(file.type || '').startsWith('video/')) return null
  if (typeof document === 'undefined') return null
  return new Promise((resolve) => {
    let url = null
    const video = document.createElement('video')
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { if (url) URL.revokeObjectURL(url) } catch { /* ignore */ }
      resolve(result)
    }
    try {
      url = URL.createObjectURL(file)
      video.muted = true
      video.playsInline = true
      video.preload = 'metadata'
      video.onloadeddata = () => {
        try {
          const d = Number.isFinite(video.duration) ? video.duration : 1
          video.currentTime = Math.min(0.1, d / 2)
        } catch { finish(null) }
      }
      video.onseeked = () => {
        try {
          const w = video.videoWidth
          const h = video.videoHeight
          if (!w || !h) return finish(null)
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0, w, h)
          canvas.toBlob((blob) => {
            if (!blob) return finish(null)
            const base = (file.name || 'video').replace(/\.[^.]+$/, '')
            finish(new File([blob], `${base}-poster.jpg`, { type: 'image/jpeg' }))
          }, 'image/jpeg', 0.82)
        } catch { finish(null) }
      }
      video.onerror = () => finish(null)
      video.src = url
    } catch { finish(null) }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/landing-media-upload.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-media-upload.js src/lib/landing-media-upload.test.js
git commit -m "feat(landing): captureVideoPoster first-frame helper"
```

---

### Task 3: `VideoTestimonials` public client widget

The interactive tiles. Idle = poster `<img>` + play button (zero video bytes). On tap = native `<video autoPlay controls>`.

**Files:**
- Create: `src/components/landing-page/VideoTestimonials.jsx`

- [ ] **Step 1: Create the widget**

Create `src/components/landing-page/VideoTestimonials.jsx`:

```jsx
'use client'

// Public client island for the `video_testimonials` block. Each tile
// renders ONLY a poster <img> + play button until tapped — no <video>
// element, so the section's first paint downloads zero video bytes
// (the whole point of "load quickly"). Tapping swaps in a native
// <video> with controls + sound. The pure BlockRenderers components
// can't hold the per-tile playing state, so this lives on its own
// (same pattern as WaitlistWidget for the lead-form block).

import { useState } from 'react'
import { Play } from 'lucide-react'

export default function VideoTestimonials({ items = [] }) {
  const clips = (Array.isArray(items) ? items : []).filter((it) => it && it.video_url).slice(0, 3)
  if (clips.length === 0) return null
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 md:gap-6 max-w-4xl mx-auto">
      {clips.map((clip, i) => (
        <VideoTile key={i} clip={clip} />
      ))}
    </div>
  )
}

function VideoTile({ clip }) {
  const [playing, setPlaying] = useState(false)
  return (
    <figure className="relative aspect-[9/16] overflow-hidden rounded-xl bg-white/5 border border-white/10">
      {playing ? (
        <video
          src={clip.video_url}
          poster={clip.poster_url || undefined}
          className="absolute inset-0 w-full h-full object-cover bg-black"
          autoPlay
          controls
          playsInline
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="absolute inset-0 w-full h-full group"
          aria-label={clip.name ? `Play ${clip.name}'s testimonial` : 'Play testimonial'}
        >
          {clip.poster_url ? (
             
            <img
              src={clip.poster_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/40" aria-hidden="true" />
          )}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-16 h-16 rounded-full bg-black/50 backdrop-blur flex items-center justify-center transition group-hover:bg-black/70 group-hover:scale-105">
              <Play size={28} className="text-white translate-x-0.5" fill="currentColor" />
            </span>
          </span>
          {clip.name && (
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-left text-sm font-medium text-white">
              {clip.name}
            </span>
          )}
        </button>
      )}
    </figure>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx eslint src/components/landing-page/VideoTestimonials.jsx`
Expected: no errors. (The `<img>` is intentional — the codebase uses plain `<img>` for Supabase URLs throughout `BlockRenderers.jsx`; the blank line before it mirrors the existing eslint-disable spacing used there.)

- [ ] **Step 3: Commit**

```bash
git add src/components/landing-page/VideoTestimonials.jsx
git commit -m "feat(landing): VideoTestimonials public client widget"
```

---

### Task 4: Renderer dispatch — `VideoTestimonialsBlock`

The pure block renderer that the public page + edit iframe dispatch to. Renders the section heading (editable inline) and embeds the `VideoTestimonials` widget.

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` (add an import ~line 16; add a `switch` case ~line 60; add the block component near `ReviewsBlock`)

- [ ] **Step 1: Add the import**

In `src/components/landing-page/BlockRenderers.jsx`, after the `WaitlistWidget` import (~line 16) add:

```jsx
import VideoTestimonials from './VideoTestimonials'
```

- [ ] **Step 2: Add the switch case**

In the `BlockRenderer` `switch (block.type)` (~line 50-62), add this line right after the `reviews` case:

```jsx
    case 'video_testimonials': return <VideoTestimonialsBlock block={block} onEdit={localOnEdit} />
```

- [ ] **Step 3: Add the block component**

Add this exported function near the other block components (e.g. directly after `ReviewsBlock` ends, ~line 485 — before the `ReviewCard` helper is fine too; just keep it module-top-level):

```jsx
// Video testimonials — up to 3 portrait clips. The pure renderer draws
// the section + (editable) heading; the interactive poster→tap-to-play
// tiles live in the VideoTestimonials client island so first paint
// ships zero video bytes. Hidden on the public page when no clip has a
// video_url; in edit mode it stays visible with a hint so the operator
// can find the section + edit the heading.
export function VideoTestimonialsBlock({ block, onEdit }) {
  const clips = (Array.isArray(block.items) ? block.items : []).filter((it) => it && it.video_url).slice(0, 3)
  if (clips.length === 0 && !onEdit) return null
  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || onEdit) && (
          <p className="text-xs uppercase tracking-[0.3em] text-white/50 mb-8 text-center">
            <E value={block.title} onEdit={onEdit} path={['title']} />
          </p>
        )}
        {clips.length > 0 ? (
          <VideoTestimonials items={clips} />
        ) : onEdit ? (
          <div className="max-w-md mx-auto text-center text-white/40 text-sm border border-dashed border-white/20 rounded py-10">
            Add up to 3 portrait videos in the &ldquo;Video testimonials&rdquo; panel on the left.
          </div>
        ) : null}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Verify the welcome page renders through `BlockRenderer`**

Run: `grep -n "BlockRenderer" 'src/app/welcome/[location]/page.js'` (quote the bracket path — zsh treats `[…]` as a glob)
Expected: a match showing the page maps blocks through `<BlockRenderer .../>`. (If it does — it does for every other block — no page change is needed; the new case is picked up automatically. If, surprisingly, it doesn't, STOP and report: the page hand-lists block types and needs the new case added there too.)

- [ ] **Step 5: Run lint**

Run: `npx eslint src/components/landing-page/BlockRenderers.jsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx
git commit -m "feat(landing): dispatch + render the video_testimonials block"
```

---

### Task 5: Editor panel — `VideoTestimonialsEdit`

The form panel where the operator uploads each clip (auto-poster on upload) and sets the name. Mirrors `PillarsEdit` (multi-item with `MediaSlot`).

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx` (add import ~line 27; add `summaryFor` case ~line 613; add `BlockEditPanel` case ~line 633; add the `VideoTestimonialsEdit` component near `PillarsEdit`)

- [ ] **Step 1: Import the capture helper**

In `src/components/LandingPageSettingsForm.jsx`, change the existing import (~line 27):

```jsx
import { uploadLandingMedia } from '@/lib/landing-media-upload'
```

to:

```jsx
import { uploadLandingMedia, captureVideoPoster } from '@/lib/landing-media-upload'
```

(`uploadLandingMedia` stays referenced inside `uploadMedia`; the new `captureVideoPoster` is used by the editor below.)

- [ ] **Step 2: Add the collapsed-card summary**

In `summaryFor(block)` (~line 602-616), add a case right after the `reviews` case:

```jsx
    case 'video_testimonials': {
      const n = (block.items || []).filter((it) => it && it.video_url).length
      return `${n} video${n === 1 ? '' : 's'}`
    }
```

- [ ] **Step 3: Add the BlockEditPanel dispatch case**

In `BlockEditPanel` (~line 622-636), add a case right after the `reviews` case:

```jsx
    case 'video_testimonials': return <VideoTestimonialsEdit {...props} />
```

- [ ] **Step 4: Add the editor component**

Add this component directly after `PillarsEdit` ends (~line 829), so it sits with the other multi-item editors:

```jsx
function VideoTestimonialsEdit({ block, onUpdate, uploadMedia, uploading, uploadErr }) {
  const items = Array.isArray(block.items) ? block.items : []
  const setItem = (i, patch) => onUpdate({ items: items.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const addItem = () => onUpdate({ items: [...items, { video_url: '', poster_url: '', name: '' }] })
  const removeItem = (i) => onUpdate({ items: items.filter((_, j) => j !== i) })
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onUpdate({ items: next })
  }

  // On clip upload: capture the poster from the LOCAL file first (no
  // CORS), upload it via the image path, then upload the video. Store
  // both URLs on the item. A failed poster capture is non-fatal — the
  // clip still saves and the tile falls back to a placeholder.
  const onUploadClip = async (i, file, posterKey, videoKey) => {
    const posterFile = await captureVideoPoster(file)
    let poster_url = ''
    if (posterFile) {
      poster_url = (await uploadMedia({ file: posterFile, kind: 'image', key: posterKey })) || ''
    }
    const video_url = await uploadMedia({ file, kind: 'video', key: videoKey })
    if (video_url) setItem(i, { video_url, poster_url })
  }

  return (
    <>
      <Field label="Section heading">
        <Input value={block.title || ''} onChange={(v) => onUpdate({ title: v })} maxLength={200} placeholder="Hear from our members" />
      </Field>
      {items.slice(0, 3).map((it, i) => {
        const posterKey = `${block.id}-vt-${i}-poster`
        const videoKey = `${block.id}-vt-${i}-video`
        return (
          <div key={i} className="border border-un1t-border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-un1t-muted">Video {i + 1}</div>
              <div className="flex items-center gap-1">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move up"><ArrowUp size={11} /></button>
                <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="p-1 text-un1t-muted hover:text-un1t-text disabled:opacity-30" title="Move down"><ArrowDown size={11} /></button>
                <button type="button" onClick={() => removeItem(i)} className="p-1 text-un1t-muted hover:text-red-400" title="Remove video"><Trash2 size={11} /></button>
              </div>
            </div>
            <MediaSlot
              url={it.video_url || ''}
              onClear={() => setItem(i, { video_url: '', poster_url: '' })}
              onUpload={(file) => onUploadClip(i, file, posterKey, videoKey)}
              uploading={!!uploading[videoKey] || !!uploading[posterKey]}
              error={uploadErr[videoKey] || uploadErr[posterKey]}
              accept="video/mp4,video/webm"
              label="Add video"
              kind="video"
            />
            <Input value={it.name || ''} onChange={(v) => setItem(i, { name: v })} maxLength={120} placeholder="Member name (e.g. Sarah)" />
          </div>
        )
      })}
      {items.length < 3 && (
        <button type="button" onClick={addItem} className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5">
          <Plus size={12} /> Add video
        </button>
      )}
      <p className="text-[11px] text-un1t-muted">MP4 / WebM, ≤ 25MB each. Portrait clips work best. We grab the first frame as the still image automatically. Tip: 720p, 15–30 seconds.</p>
    </>
  )
}
```

(`ArrowUp`, `ArrowDown`, `Trash2`, `Plus`, `Field`, `Input`, `MediaSlot` are all already imported/defined in this file — no new icon imports needed.)

- [ ] **Step 5: Lint + typecheck the form**

Run: `npx eslint src/components/LandingPageSettingsForm.jsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx
git commit -m "feat(landing): VideoTestimonialsEdit editor panel + auto-poster on upload"
```

---

### Task 6: Full verification + ship

**Files:** none (verification only)

- [ ] **Step 1: Run the CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports
```
Expected: all green. Tests include the new block-factory + capture-guard cases. Parity is unaffected (no new `WEB_PERMISSIONS` key — block editing reuses `landing_page`).

- [ ] **Step 2: Run a real production build** (catches import-resolution / Turbopack failures the CI mirror misses)

```bash
npm run build
```
Expected: exit 0. (This is the only check that catches a bad import like the new `VideoTestimonials` / `captureVideoPoster` paths.)

- [ ] **Step 3: Manual verification (operator flow)**

In the landing-page editor (`/settings/landing-page`, pick the Hatch Street studio): **Add section → Video testimonials**. Upload 3 portrait clips, set a name on each, Save. Then open the public page (`/hatch-street`) and confirm:
1. the section shows 3 portrait posters with names + play buttons,
2. nothing downloads the video until you tap (DevTools → Network shows only the 3 poster JPEGs on load),
3. tapping a tile plays it with sound and the fullscreen control works,
4. removing all clips (or an empty section) renders nothing on the public page.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin video-testimonials-block
```
Then open a PR (`base: main`, title `LANDING-VIDEO.1 — video testimonials block`) per the canonical ship loop in CLAUDE.md, body summarizing: new `video_testimonials` block, poster + tap-to-play (zero video bytes until tap), auto-captured first-frame posters, name-only attribution, reuses `uploadLandingMedia`, no migration / no route / no permission key. End with the `Verified:` line (tests · lint · parity · imports · build · manual) and the Claude Code trailer.
