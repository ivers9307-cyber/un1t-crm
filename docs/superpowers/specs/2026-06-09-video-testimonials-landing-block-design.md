# Video testimonials landing-page block — design

**Date:** 2026-06-09
**Status:** Approved (design) — pending spec review → implementation plan
**Author:** Claude (brainstormed with Richard)

## Problem

The UN1T landing pages (`/welcome/[location]`, e.g. Hatch Street) want a **video testimonials** section: up to 3 **portrait** member videos that **load quickly**. The existing block library has a single-quote text `testimonial` block and a YouTube/Instagram `embed` block, but nothing for self-hosted portrait member clips shown as a grid.

The page is server-rendered and CDN-cached, and a hero background is already the heaviest thing on first paint — so the section must add near-zero first-paint weight.

## Decisions locked (brainstorming)

- **Playback:** **poster image + tap-to-play, with sound.** Each tile shows a still poster; the video downloads only when a visitor taps. This is the lightest-load option and the right fit for spoken testimonials.
- **Attribution:** **name only** per clip (no caption/quote line).
- **Poster source:** **auto-capture the video's first frame** client-side at upload time (operator just uploads a video; no separate poster upload). Option to add a manual poster override is explicitly deferred (YAGNI).
- **Count:** up to **3** clips (operator adds 1–3).
- **Distinct block:** a new `video_testimonials` block — NOT an extension of `embed` (iframe-based) or `testimonial` (single text quote).

## Goals

- A new operator-configurable `video_testimonials` landing block that renders up to 3 portrait member videos.
- First paint of the section = three small poster JPEGs and **zero video bytes** until a visitor taps play.
- Reuse the existing media-upload infrastructure (`uploadLandingMedia`) and the block factory/registry/renderer/editor patterns — no new API route, no migration.

## Non-goals

- Manual poster-image override (auto-capture only for v1; can extend to a hybrid later).
- More than 3 clips, captions/quotes, autoplay loops, or muted-loop playback (all considered and rejected during brainstorming).
- Any change to the existing `testimonial` (text) or `embed` (YouTube/IG) blocks.
- A new permission key — block editing keeps using the existing `landing_page` gate.

## Architecture

The landing page renders an ordered list of **blocks**. Blocks are defined by a factory + registry in `src/lib/landing-page-blocks.js`, validated by a Zod schema there, dispatched for render by `src/components/landing-page/BlockRenderers.jsx`, and edited by per-type sub-components in `src/components/LandingPageSettingsForm.jsx`. Multi-item blocks (`pillars`, `gallery`, `stats`) already carry an `items: [...]` array — `video_testimonials` follows that exact shape with `video_url` + `poster_url` + `name` per item.

Media already uploads via `src/lib/landing-media-upload.js → uploadLandingMedia({ file, locationId, kind })`:
- `kind:'video'` → direct-to-Supabase-Storage signed-URL PUT (bypasses Vercel's ~4.5MB body cap; 25MB / MP4·WebM ceiling, into the `branding` bucket).
- `kind:'image'` → client-side canvas downscale/compress then POST.

The poster is produced by capturing the first frame of the **local** file (blob URL → no CORS) and uploading it through the existing `kind:'image'` path.

```
operator adds a clip (local File):
  posterFile = captureVideoPoster(file)        // hidden <video> → seek 0.1s → canvas → JPEG
  poster_url = uploadLandingMedia(posterFile, kind:'image')
  video_url  = uploadLandingMedia(file,       kind:'video')
  item       = { video_url, poster_url, name }

public render (welcome page, cached):
  BlockRenderers → <VideoTestimonials items title/>  (client island)
    per tile: <img poster loading="lazy"> + play overlay + name   ← zero video bytes
    on tap  : swap to <video src autoplay controls playsinline poster>  ← sound on
```

## Components

### 1. Block definition — `src/lib/landing-page-blocks.js` (+ test)
- `VIDEO_TESTIMONIALS_DEFAULT = () => ({ id, type:'video_testimonials', title:'Hear from our members', items: [] })`.
- Register in `BLOCK_TYPES`: `{ type:'video_testimonials', label:'Video testimonials', description:'Up to 3 portrait member videos. Tap to play.', factory: VIDEO_TESTIMONIALS_DEFAULT }`.
- Extend the block Zod schema so the new `type` is accepted and the `items` shape (`{ video_url, poster_url, name }`, each optional string, capped at 3) validates — mirroring how `pillars`/`gallery` items are handled. Match whatever per-type validation strictness those blocks use.

### 2. Poster capture — `src/lib/landing-media-upload.js`
- New `captureVideoPoster(file): Promise<File|null>` — browser-only (uses `<video>` + `<canvas>`, same as the existing `compressImageFile`). Loads the local file via `URL.createObjectURL`, waits for `loadeddata`, seeks to ~0.1s, draws the current frame to a canvas sized to the video's natural dimensions, exports a JPEG `File` (reusing the existing quality/size clamps). Revokes the blob URL. Resolves `null` on any decode/seek failure so the caller degrades gracefully.

### 3. Public renderer — `src/components/landing-page/VideoTestimonials.jsx` (new, client)
- `'use client'` island (the welcome page is server-rendered/cached; interactive playback needs the client, same approach as the lead-form `WaitlistWidget`).
- Props: `{ title, items }`. Renders nothing if no item has a `video_url`.
- Section heading = `title`; grid of portrait (9:16) tiles — 3-across on desktop, stacked on mobile.
- Each tile, idle state: a plain `<img src={poster_url} loading="lazy">` (or a branded dark placeholder if no poster), a centered play-button overlay, and the member `name`. **No `<video>` element rendered, so no video bytes fetched.**
- On tap (per-tile `playing` state): render `<video src={video_url} poster={poster_url} autoPlay controls playsInline>` in place of the image. Native controls provide scrub + fullscreen + the volume control; sound is on.

### 4. Renderer dispatch — `src/components/landing-page/BlockRenderers.jsx`
- Add a `case 'video_testimonials'` that renders `<VideoTestimonials title={block.title} items={block.items} />`.

### 5. Editor — `src/components/LandingPageSettingsForm.jsx`
- New `VideoTestimonialsEdit({ block, onUpdate, uploadMedia, uploading, uploadErr })`, wired into the form's per-block edit dispatch like `HeroEdit`/the pillars/gallery editors.
- A `title` text field.
- An **"Add video (up to 3)"** list. Each row:
  - a **video file input** whose handler runs capture-poster → upload poster (`kind:'image'`) → upload video (`kind:'video'`) → writes `{ video_url, poster_url, name }` onto the item (reusing the form's per-key `uploading`/`uploadErr` spinner + error state);
  - a **name** text field;
  - a small **poster thumbnail** preview once captured;
  - a **remove** button.
- "Add" disabled at 3 items.

## Data flow / correctness

- The block stores only URLs + name; no binary lives in the block JSON.
- Poster captured from the **local** file pre-upload → no CORS, no dependency on the public bucket being canvas-readable.
- `preload` is effectively `none` because the idle tile renders an `<img>`, not a `<video>` — the strongest possible "load quickly" guarantee.
- Owned entirely by the existing landing-page settings persistence (the block array is saved with the rest of the page); no new endpoint.

## Error handling

- `captureVideoPoster` resolves `null` on failure; the item saves with `poster_url` empty and the tile shows the placeholder. The clip still plays on tap.
- Upload failures surface inline per row via the existing `parseUploadResponse` messaging (413/oversize → "try 720p, 5–15s, ~3–5Mbps"; unsupported type → "Use MP4 or WebM").
- Empty/again-empty `items`, or items missing `video_url`, render no section (no empty-state clutter on the public page).

## Testing

- `landing-page-blocks.test.js`: the `video_testimonials` factory returns the expected shape; the block schema accepts a valid block and the registry exposes the new type (mirror existing block-factory/schema tests).
- `captureVideoPoster` is canvas/DOM-heavy and not meaningfully unit-testable without a jsdom canvas; cover any pure helper (e.g. poster filename derivation) and rely on manual verification for the frame grab itself.
- Build + manual: add a `video_testimonials` block in the landing editor, upload 3 portrait clips, confirm (a) posters auto-generate, (b) the public section shows 3 posters with names and downloads no video until tapped, (c) tap plays with sound + fullscreen works, (d) a failed/again-empty slot degrades cleanly.

## Files touched

| File | Change |
|---|---|
| `src/lib/landing-page-blocks.js` (+ `.test.js`) | new `video_testimonials` factory + registry entry + schema |
| `src/lib/landing-media-upload.js` | new `captureVideoPoster(file)` helper |
| `src/components/landing-page/VideoTestimonials.jsx` | new client renderer (poster → tap-to-play) |
| `src/components/landing-page/BlockRenderers.jsx` | dispatch the new block type |
| `src/components/LandingPageSettingsForm.jsx` | new `VideoTestimonialsEdit` editor |

No migration, no new API route (reuses `uploadLandingMedia` + the existing landing-page settings save). No new permission key → no mobile-parity obligation.

## Open questions

None outstanding. Locked: poster+tap+sound playback, name-only attribution, auto-captured first-frame posters, up to 3 clips, dedicated block. Implementation detail to confirm in the plan (not a blocker): exact `VideoTestimonials` tile markup/Tailwind and whether the schema validates item fields strictly or loosely (match the `pillars`/`gallery` precedent).
