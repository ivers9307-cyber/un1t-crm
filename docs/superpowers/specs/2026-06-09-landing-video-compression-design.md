# Landing-page video compression (in-browser) — design

**Date:** 2026-06-09
**Status:** Approved (design) — pending spec review → implementation plan
**Author:** Claude (brainstormed with Richard)

## Problem

The landing-page video uploads (the new `video_testimonials` block, and the `hero` background video) reject anything over ~25MB. The hard ceiling is the Supabase `branding` bucket's `file_size_limit = 27262976` (26MB, mig 248); the `MAX_VIDEO_BYTES = 25MB` check in `src/lib/landing-media-upload.js` just gives a friendlier client-side error before the bucket rejects. An operator's 65MB phone clip can't be uploaded.

We need to (a) accept larger source files and (b) compress them while keeping good quality — without wrecking the block's "load quickly" goal (first paint is poster images only; a clip downloads only when a visitor taps its tile).

## Decisions locked (brainstorming)

- **Compress in the browser before upload** — operators upload from a **computer** (Mac/PC), which has the RAM/CPU to transcode; keep everything **in-house** (no streaming-provider vendor, no recurring cost). Storage stays on the existing Supabase `branding` bucket.
- **Engine: `ffmpeg.wasm`, single-threaded core.** Predictable H.264/MP4 output + quality control (CRF) + works in every desktop browser. The **single-threaded** core specifically: the multithreaded core needs cross-origin-isolation (COOP/COEP) headers, which would break the app's embed blocks, the Unlayer email editor, Revolut checkout, etc. ST is slower but needs none of that.
- **Self-hosted core** (served from `/public`), so there's no runtime third-party CDN fetch.
- **Automatic + transparent** — no extra operator clicks; the upload tile shows compression + upload progress.
- **Target: 720p H.264.** Cap the long edge at 1280, never upscale, CRF ~27 (high quality for phone-shot portrait video), AAC audio, MP4 with faststart. A 30–60s clip typically lands ~8–15MB.
- **Applies to the shared landing video-upload path**, so it fixes the testimonials block AND the hero video (same code path, same bug) — DRY.

## Goals

- An operator can pick a large (e.g. 65MB, up to ~500MB) video; the browser compresses it to a web-optimized 720p MP4 and uploads the result.
- Already-small, web-friendly clips (≤ ~20MB, MP4/WebM) upload untouched — no needless re-encode / quality loss.
- The heavy ffmpeg core loads **lazily, only in the landing editor**, never on the public page.
- First-paint of the public testimonials section is unchanged (posters only; video on tap).
- No new vendor, no recurring cost, no COOP/COEP headers.

## Non-goals

- A streaming provider / adaptive HLS (explicitly ruled out — in-house only).
- Mobile-browser transcoding (operators upload from a computer; mobile would risk OOM — see Error handling for the graceful path if it's ever attempted).
- Multithreaded ffmpeg / cross-origin isolation.
- Changing the public renderer / `VideoTestimonials` widget (untouched — it still plays a plain `<video src>`; the stored file is just smaller).
- Server-side transcoding.

## Architecture

Compression slots into the **shared** client video-upload path so every landing video upload benefits:

```
operator picks a video File (in the editor)
  → uploadLandingMedia({ file, locationId, kind:'video', onProgress })
      1. reject if file.size > MAX_VIDEO_INPUT_BYTES (~500MB) — browser-memory guard
      2. out = await compressVideoIfNeeded(file, { onProgress })   // ← new
           - passthrough (return file) if size ≤ PASSTHROUGH_MAX_BYTES and mp4/webm
           - else lazy-load ffmpeg.wasm (ST core from /public) and transcode to 720p H.264 MP4
           - on ANY ffmpeg failure → return the ORIGINAL file (fail-open)
      3. uploadVideoDirect(out)  // existing signed-URL PUT; bucket enforces the OUTPUT ceiling
  → returns { success, url }
onProgress reports { phase: 'compress'|'upload', percent } so the tile shows
"Compressing… NN%" then "Uploading…"
```

`compressVideoIfNeeded` lives in a **new, isolated** `src/lib/video-compress.js` (browser-only; lazy `import()` of `@ffmpeg/ffmpeg`). `uploadLandingMedia` calls it; everything downstream (signed-upload route, bucket, public renderer) is unchanged except the bucket size limit.

## Components

### 1. `src/lib/video-compress.js` (new, browser-only)
- `shouldCompress(file)` — **pure**, unit-tested: returns `false` (passthrough) when `file.size <= PASSTHROUGH_MAX_BYTES` AND `file.type` ∈ {`video/mp4`,`video/webm`}; `true` otherwise. (A >20MB webm/mp4, or any other container, gets transcoded.)
- `compressVideoIfNeeded(file, { onProgress } = {})` — IO: if `!shouldCompress(file)` return `file` unchanged. Else lazy-load ffmpeg, transcode, return a new `File` (`<base>.mp4`, `video/mp4`). On load/transcode error, log + return the **original** `file` (fail-open — the size check / bucket downstream gives the user a clear ceiling error rather than a crash).
- ffmpeg lifecycle: a module-level singleton `FFmpeg` instance, `load()`ed once (idempotent) with `coreURL: '/ffmpeg/ffmpeg-core.js'`, `wasmURL: '/ffmpeg/ffmpeg-core.wasm'` (self-hosted, see §5). Progress via ffmpeg's `progress` event → `onProgress({ phase:'compress', percent })`.
- Transcode args (intent — plan finalizes exact flags): scale to fit within a 1280×1280 box keeping aspect, **never upscale**, even dimensions; `-c:v libx264 -crf 27 -preset veryfast -c:a aac -b:a 128k -movflags +faststart`. Representative:
  `ffmpeg -i in -vf "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2" -c:v libx264 -crf 27 -preset veryfast -c:a aac -b:a 128k -movflags +faststart out.mp4`

### 2. `src/lib/landing-media-upload.js`
- `uploadLandingMedia` gains an optional `onProgress` param. For `kind:'video'`: check `MAX_VIDEO_INPUT_BYTES` (~500MB) on the raw file → `compressVideoIfNeeded(file, { onProgress })` → pass the result to the existing `uploadVideoDirect`.
- `uploadVideoDirect`: keep the type check; replace the hard 25MB `MAX_VIDEO_BYTES` gate with the new **output** ceiling = the bucket limit (50MB) so a compressed/passthrough file that fits the bucket uploads, and an over-ceiling output gets a clear message. Wire its existing PUT to optionally report `onProgress({ phase:'upload', percent })` (best-effort; `uploadToSignedUrl` may not expose granular progress — if not, emit a single 'upload' phase marker so the tile flips to "Uploading…").
- Constants: `MAX_VIDEO_INPUT_BYTES = 500 * 1024 * 1024`; `PASSTHROUGH_MAX_BYTES = 20 * 1024 * 1024` (in `video-compress.js`); output ceiling = 50MB (bucket).

### 3. Migration `supabase/migrations/250_branding_bucket_video_50mb.sql`
- `update storage.buckets set file_size_limit = 52428800 where id = 'branding';` (50MB). Keep the existing `allowed_mime_types`. This is the only schema change; no new table/column.

### 4. `src/components/LandingPageSettingsForm.jsx` — progress UX
- `uploadMedia({ file, kind, key })` threads an `onProgress` into `uploadLandingMedia` and writes a per-`key` progress value into a new `progress` state map (`{ [key]: { phase, percent } }`), alongside the existing `uploading`/`uploadErr` maps.
- `MediaSlot` shows the phase + percent when present: **"Compressing… 45%"** → **"Uploading…"** → preview. Falls back to the current plain "Uploading…" spinner when no progress is reported (images, or upload phase without granular progress).
- No change to `VideoTestimonialsEdit`/`HeroEdit` call shapes beyond getting the richer status for free (both already call `uploadMedia` with a per-key `key`).

### 5. ffmpeg core assets + deps
- Add deps: `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core` (the **single-thread** core).
- Copy `@ffmpeg/core/dist/esm/ffmpeg-core.js` + `ffmpeg-core.wasm` into `public/ffmpeg/` via a `postinstall` script (`scripts/copy-ffmpeg-core.mjs`), and **gitignore `public/ffmpeg/`** so the ~25MB wasm isn't committed but is present in dev + on Vercel (postinstall runs after `npm install` in both). This keeps the core self-hosted (no runtime CDN) without bloating git history.

## Data flow / correctness

- Compression is **before** upload, so the bucket only ever receives the compressed (or small passthrough) output — the 50MB bucket ceiling is comfortable.
- Poster capture (testimonials) stays as today, captured from the **original** local file (same first frame; posters are downscaled via the image path regardless) — so it's independent of the transcode and needs no change.
- The public renderer + `VideoTestimonials` widget are untouched: they still play `<video src={stored mp4}>`; the file is simply smaller.
- Passthrough preserves the operator's original bytes for already-optimized clips (no generational quality loss).

## Error handling

- **Input too big** (> ~500MB): rejected before any work, with a clear message ("That video is very large (NNN MB). Trim it or export at 720p, then re-upload.").
- **ffmpeg fails to load / transcode errors / browser OOM:** `compressVideoIfNeeded` catches, logs, and returns the **original** file (fail-open). Then `uploadVideoDirect` checks it against the 50MB bucket ceiling: if the original happens to fit, it uploads; if not, the operator gets the existing friendly "too large" message. No crash, no stuck spinner.
- **Compressed output still > 50MB** (e.g. a multi-minute clip): clear "still too large after compression — please upload a shorter clip" message (the bucket would reject anyway; we pre-check the output size for a friendlier error).
- All consistent with the file's existing best-effort `{ success, error }` return shape.

## Risks

- **`ffmpeg.wasm` + Next 16 / Turbopack integration is the main risk** (worker creation, wasm/core URL resolution). Mitigations: (1) the helper is browser-only and `import()`s `@ffmpeg/ffmpeg` **dynamically** (never SSR); (2) the core js+wasm are **self-hosted in `/public`** and referenced by URL (not bundled), sidestepping bundler wasm handling; (3) it's used only inside the client `LandingPageSettingsForm`. **The plan must include a real `npm run build` AND a manual transcode smoke test** — green vitest does not prove the worker/wasm loads.
- **Fallback if ffmpeg.wasm proves too painful to integrate:** a built-in `MediaRecorder` + `<canvas>` real-time re-encode (no heavy dep, WebM output) is the documented Plan B. Not chosen now (coarser quality control, WebM, real-time speed) but noted so implementation isn't blocked if the wasm/worker fights Turbopack.
- **Transcode time:** ST core on a 65MB clip ≈ 1–2 min on a typical laptop. Acceptable for an occasional operator action, made tolerable by the progress bar. (Mobile is out of scope.)

## Testing

- **Unit (`video-compress.test.js`):** `shouldCompress` — passthrough for ≤20MB mp4/webm; compress for >20MB mp4, for a non-mp4/webm container, and for an oversized webm. (Pure; the transcode itself isn't unit-testable in jsdom — no real codecs — same posture as `captureVideoPoster`.)
- **Build:** `npm run build` must pass with the new dynamic ffmpeg import + `/public` core.
- **Manual (the real gate):** in the landing editor, upload the operator's 65MB clip → watch "Compressing… NN%" → "Uploading…" → preview; confirm the stored file is ~8–15MB and plays with sound on the public page; upload a small (<20MB) clip → confirm it passes through without re-encoding; confirm the hero video upload also compresses.

## Files touched

| File | Change |
|---|---|
| `src/lib/video-compress.js` (+ `.test.js`) | new — `shouldCompress` (pure) + `compressVideoIfNeeded` (ffmpeg.wasm, lazy, fail-open) |
| `src/lib/landing-media-upload.js` | input cap, call compression for `kind:'video'`, thread `onProgress`, output ceiling = bucket |
| `supabase/migrations/250_branding_bucket_video_50mb.sql` | bucket `file_size_limit` → 50MB |
| `src/components/LandingPageSettingsForm.jsx` | `progress` state + thread `onProgress`; `MediaSlot` shows "Compressing… NN%" / "Uploading…" |
| `package.json` | `@ffmpeg/ffmpeg` + `@ffmpeg/util` + `@ffmpeg/core` deps; `postinstall` copy script |
| `scripts/copy-ffmpeg-core.mjs` (new) + `.gitignore` | self-host the ST core into `public/ffmpeg/` (gitignored) |

No new permission key (editor stays on `landing_page`); no new API route; one tiny migration.

## Open questions

None blocking. Tunable during implementation (not blockers): exact ffmpeg flags (CRF/preset), the 20MB passthrough threshold, and the 500MB input cap. The one genuine implementation risk (ffmpeg.wasm × Turbopack) has a mitigation path and a documented `MediaRecorder` fallback.
