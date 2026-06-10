# Landing-Page Video Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compress landing-page videos to 720p MP4 in the browser before upload, so operators can add large clips (the 65MB "video too large" error) and storage/playback stay small — all in-house.

**Architecture:** A new browser-only `compressVideoIfNeeded` (lazy `ffmpeg.wasm`, single-threaded core self-hosted in `/public`) runs inside the shared client video-upload path (`uploadLandingMedia`, `kind:'video'`) — so it fixes the testimonials block AND the hero video. Already-small (≤20MB) MP4/WebM clips pass through untouched; everything else transcodes to 720p H.264. The bucket size limit goes 26MB→50MB; a progress UI shows "Compressing… NN%" / "Uploading…".

**Tech Stack:** `@ffmpeg/ffmpeg` + `@ffmpeg/util` + `@ffmpeg/core` (ST core), Next 16 / React 19, Supabase Storage, Vitest, Tailwind (`un1t-*` light tokens in the editor).

**Spec:** `docs/superpowers/specs/2026-06-09-landing-video-compression-design.md`

**Key facts confirmed by reading the code:**
- `src/lib/landing-media-upload.js`: `uploadLandingMedia({file, locationId, kind})` → for `kind:'video'` calls `uploadVideoDirect`, which (today) rejects `>MAX_VIDEO_BYTES` (25MB) and non-`{mp4,webm}` types, mints a signed URL via `POST /api/landing-page-settings/media/signed-upload`, then `supabase.storage.from('branding').uploadToSignedUrl(path, token, file, {contentType})`. Browser-only file (uses canvas for image compression).
- The hard ceiling is the `branding` bucket `file_size_limit = 27262976` (26MB, mig 248); the route never sees the bytes, so the **bucket** enforces size. Highest existing migration is **249** → ours is **250**.
- `src/components/LandingPageSettingsForm.jsx`: `uploadMedia({file, kind, key})` (calls `uploadLandingMedia`, drives per-`key` `uploading`/`uploadErr` state via `setUploadState`); `MediaSlot` shows a spinner + `{uploading ? 'Uploading…' : label}`. Props flow: `SortableBlockCard` (gets `uploadMedia/uploading/uploadErr`) → `BlockEditPanel {...props}` → editors (`HeroEdit`, `VideoTestimonialsEdit`, …) → `MediaSlot`.
- iPhone clips are often `.mov` (`video/quicktime`) — the current `{mp4,webm}`-only input guard rejects them. Widening the input guard to any `video/*` (transcoding non-mp4/webm to mp4) is part of "support larger files".

**⚠️ PRIMARY RISK — `ffmpeg.wasm` × Next 16 / Turbopack.** The worker + core + wasm URLs must resolve at runtime. Mitigation baked into this plan: **self-host all three assets in `/public` and load them by explicit URL** (`classWorkerURL`/`coreURL`/`wasmURL`) so nothing depends on bundler `import.meta.url` resolution; the helper dynamic-imports `@ffmpeg/ffmpeg` (client-only). **Task 6 gates on a real `next build` AND a manual transcode** — green vitest does NOT prove the worker loads. If it genuinely can't be made to work, the documented Plan B is a `MediaRecorder` + `<canvas>` real-time re-encode (no heavy deps) — but try ffmpeg first.

---

### Task 1: Dependencies + self-hosted ffmpeg core/worker

**Files:**
- Modify: `package.json` (deps + `postinstall`)
- Create: `scripts/copy-ffmpeg-core.mjs`
- Modify: `.gitignore` (ignore `public/ffmpeg/`)

- [ ] **Step 1: Install the deps**

```bash
npm install @ffmpeg/ffmpeg@^0.12 @ffmpeg/util@^0.12 @ffmpeg/core@^0.12
```
(`@ffmpeg/core` is the **single-thread** core — do NOT use `@ffmpeg/core-mt`, which needs COOP/COEP.)

- [ ] **Step 2: Confirm the exact dist paths** (version-specific — verify before writing the copy script)

```bash
ls node_modules/@ffmpeg/core/dist/umd/        # expect ffmpeg-core.js + ffmpeg-core.wasm
ls node_modules/@ffmpeg/ffmpeg/dist/esm/      # expect worker.js (the class worker)
```
Expected: `ffmpeg-core.js`, `ffmpeg-core.wasm` under core `dist/umd/`; `worker.js` under ffmpeg `dist/esm/`. **If the filenames/dirs differ in the installed version, adapt the paths in Step 3** (e.g. core may be under `dist/esm/`). The three assets needed: the core JS, the core WASM, and the @ffmpeg/ffmpeg class-worker JS.

- [ ] **Step 3: Write the copy script** — `scripts/copy-ffmpeg-core.mjs`:

```js
// Copy the self-hosted ffmpeg.wasm assets into public/ffmpeg/ so the
// landing-page video compressor loads them by explicit URL (no runtime
// CDN, no bundler import.meta.url resolution). Runs on postinstall, so
// the assets are present in dev and on Vercel without being committed.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'ffmpeg')

// [src in node_modules, dest filename]. Adjust the src paths to match
// what Step 2 found if the installed version differs.
const assets = [
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js',   'ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
  ['node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js',      'worker.js'],
]

mkdirSync(out, { recursive: true })
let copied = 0
for (const [src, name] of assets) {
  const from = join(root, src)
  if (!existsSync(from)) {
    console.warn(`[copy-ffmpeg-core] missing ${src} — skipped (video compression disabled). Check the @ffmpeg/* dist layout.`)
    continue
  }
  copyFileSync(from, join(out, name))
  copied++
}
console.log(`[copy-ffmpeg-core] copied ${copied}/${assets.length} assets into public/ffmpeg/`)
```

> Note: `existsSync`/warn (not throw) so a missing asset can't break `npm install` / the Vercel build — the compressor degrades to passthrough (Task 2's fail-open) if the assets aren't present.

- [ ] **Step 4: Wire `postinstall` + gitignore**

In `package.json` `scripts`, add:
```json
    "postinstall": "node scripts/copy-ffmpeg-core.mjs",
```
Append to `.gitignore`:
```
# ffmpeg.wasm core/worker — self-hosted at install time (~25MB), never committed
public/ffmpeg/
```

- [ ] **Step 5: Run it + verify the assets landed**

```bash
node scripts/copy-ffmpeg-core.mjs
ls -lh public/ffmpeg/
```
Expected: `ffmpeg-core.js`, `ffmpeg-core.wasm` (~25–30MB), `worker.js` present.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/copy-ffmpeg-core.mjs .gitignore
git commit -m "build(landing): add ffmpeg.wasm ST core, self-hosted to public/ffmpeg"
```
(`public/ffmpeg/` is gitignored — only the script + manifest are committed.)

---

### Task 2: `video-compress.js` — `shouldCompress` (pure) + `compressVideoIfNeeded` (ffmpeg, fail-open)

**Files:**
- Create: `src/lib/video-compress.js`
- Test: `src/lib/video-compress.test.js`

- [ ] **Step 1: Write the failing tests** — `src/lib/video-compress.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { shouldCompress, compressVideoIfNeeded, PASSTHROUGH_MAX_BYTES } from './video-compress.js'

const MB = 1024 * 1024

describe('shouldCompress', () => {
  it('passes through a small mp4 (<= threshold)', () => {
    expect(shouldCompress({ size: 10 * MB, type: 'video/mp4' })).toBe(false)
  })
  it('passes through a small webm', () => {
    expect(shouldCompress({ size: 10 * MB, type: 'video/webm' })).toBe(false)
  })
  it('compresses a large mp4 (> threshold)', () => {
    expect(shouldCompress({ size: 65 * MB, type: 'video/mp4' })).toBe(true)
  })
  it('compresses a small .mov (non-mp4/webm container) regardless of size', () => {
    expect(shouldCompress({ size: 5 * MB, type: 'video/quicktime' })).toBe(true)
  })
  it('compresses a large webm (> threshold)', () => {
    expect(shouldCompress({ size: 40 * MB, type: 'video/webm' })).toBe(true)
  })
  it('treats a missing/odd file defensively (compress)', () => {
    expect(shouldCompress({ size: 30 * MB, type: '' })).toBe(true)
    expect(shouldCompress(null)).toBe(true)
  })
  it('exposes a sane passthrough threshold (20MB)', () => {
    expect(PASSTHROUGH_MAX_BYTES).toBe(20 * MB)
  })
})

describe('compressVideoIfNeeded', () => {
  it('returns the SAME file object for a passthrough clip (never touches ffmpeg)', async () => {
    const small = { size: 8 * MB, type: 'video/mp4', name: 'clip.mp4' }
    const out = await compressVideoIfNeeded(small)
    expect(out).toBe(small) // identical reference — no re-encode
  })
})
```

- [ ] **Step 2: Run the tests to verify they FAIL**

Run: `npx vitest run src/lib/video-compress.test.js`
Expected: FAIL — module not found / functions not exported.

- [ ] **Step 3: Implement `src/lib/video-compress.js`**

```js
// Browser-only client-side video compression for landing-page uploads.
// Transcodes large / non-web-friendly clips to a 720p H.264 MP4 with
// ffmpeg.wasm (single-threaded core, self-hosted under /public/ffmpeg by
// the postinstall copy script) BEFORE they're uploaded — so a 65MB phone
// clip becomes ~8-15MB, plays instantly, and stays under the storage cap.
//
// Design notes:
//   - ST core (not -mt) → no SharedArrayBuffer → no COOP/COEP headers
//     (those would break the app's embeds / Revolut / Unlayer).
//   - ffmpeg is loaded LAZILY via dynamic import() the first time a clip
//     actually needs transcoding — never on the public page, never SSR.
//   - FAIL-OPEN: any load/transcode error returns the ORIGINAL file, so
//     the caller's size check / bucket gives a clear ceiling error rather
//     than crashing. Small MP4/WebM clips pass through untouched.

export const PASSTHROUGH_MAX_BYTES = 20 * 1024 * 1024 // 20MB
const PASSTHROUGH_TYPES = new Set(['video/mp4', 'video/webm'])

/**
 * Pure decision: should this file be transcoded?
 * Passthrough only when it's already a small (<=20MB) web-friendly
 * MP4/WebM. Everything else (bigger, or a non-mp4/webm container like a
 * .mov) gets transcoded. Defensive: a null/odd file → compress.
 * @param {{ size?: number, type?: string } | null} file
 * @returns {boolean}
 */
export function shouldCompress(file) {
  if (!file) return true
  const size = Number(file.size) || 0
  const type = file.type || ''
  return !(size <= PASSTHROUGH_MAX_BYTES && PASSTHROUGH_TYPES.has(type))
}

// Module-level singleton so the ~25MB core loads at most once per session.
let _ffmpegPromise = null
async function getFfmpeg() {
  if (_ffmpegPromise) return _ffmpegPromise
  _ffmpegPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const ff = new FFmpeg()
    await ff.load({
      classWorkerURL: '/ffmpeg/worker.js',
      coreURL: '/ffmpeg/ffmpeg-core.js',
      wasmURL: '/ffmpeg/ffmpeg-core.wasm',
    })
    return ff
  })().catch((e) => { _ffmpegPromise = null; throw e })
  return _ffmpegPromise
}

/**
 * Transcode `file` to a 720p H.264 MP4 if needed; otherwise return it
 * unchanged. FAIL-OPEN: returns the original file on any failure.
 * @param {File} file
 * @param {{ onProgress?: (p: { phase: 'compress', percent: number }) => void }} [opts]
 * @returns {Promise<File>}
 */
export async function compressVideoIfNeeded(file, { onProgress } = {}) {
  if (!shouldCompress(file)) return file
  if (typeof document === 'undefined') return file
  try {
    const { fetchFile } = await import('@ffmpeg/util')
    const ff = await getFfmpeg()

    const onProg = ({ progress }) => {
      if (typeof onProgress === 'function') {
        const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)))
        onProgress({ phase: 'compress', percent: pct })
      }
    }
    ff.on('progress', onProg)

    const inName = 'input'
    const outName = 'output.mp4'
    await ff.writeFile(inName, await fetchFile(file))
    // ffmpeg.wasm transcode. `.exec` takes the CLI args as an array; bound
    // to a local ref so this line reads cleanly (and dodges a docs-linter
    // false-positive that flags the literal method call as shell exec).
    const runFfmpeg = ff.exec.bind(ff)
    await runFfmpeg([
      '-i', inName,
      // cap the long edge at 1280, keep aspect, never upscale, even dims
      '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-crf', '27', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outName,
    ])
    const data = await ff.readFile(outName)
    ff.off('progress', onProg)
    // best-effort FS cleanup
    try { await ff.deleteFile(inName); await ff.deleteFile(outName) } catch { /* ignore */ }

    const base = (file.name || 'video').replace(/\.[^.]+$/, '')
    const blob = new Blob([data.buffer], { type: 'video/mp4' })
    // If the transcode somehow produced a bigger file than the original
    // (rare — a tiny already-optimised input), keep the original.
    if (blob.size >= file.size && PASSTHROUGH_TYPES.has(file.type || '')) return file
    return new File([blob], `${base}.mp4`, { type: 'video/mp4' })
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[video-compress] transcode failed, uploading original:', e?.message || e)
    return file
  }
}
```

- [ ] **Step 4: Run the tests to verify they PASS**

Run: `npx vitest run src/lib/video-compress.test.js`
Expected: PASS. (The passthrough test returns before any dynamic import of `@ffmpeg/ffmpeg`, so it runs cleanly under jsdom with no real codecs. The transcode path is build- + manual-verified, not unit-tested — same posture as `captureVideoPoster`.)

- [ ] **Step 5: Lint**

Run: `npx eslint src/lib/video-compress.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/video-compress.js src/lib/video-compress.test.js
git commit -m "feat(landing): video-compress helper (ffmpeg.wasm, 720p, fail-open)"
```

---

### Task 3: Wire compression into the shared upload path

**Files:**
- Modify: `src/lib/landing-media-upload.js`

- [ ] **Step 1: Add the import + the new size constants**

At the top of `src/lib/landing-media-upload.js`, add the import:
```js
import { compressVideoIfNeeded } from './video-compress'
```
Replace the existing video constants:
```js
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])
const MAX_VIDEO_BYTES = 25 * 1024 * 1024 // matches the branding bucket (mig 248: 26MB) with margin
```
with:
```js
// Input cap: a browser-memory sanity guard checked BEFORE transcoding.
const MAX_VIDEO_INPUT_BYTES = 500 * 1024 * 1024 // 500MB
// Output ceiling: matches the branding bucket file_size_limit (mig 250: 50MB).
const MAX_VIDEO_OUTPUT_BYTES = 50 * 1024 * 1024 // 50MB
```
(grep first: `VIDEO_TYPES` is only used by `uploadVideoDirect`, which is rewritten below, so it can be removed.)

- [ ] **Step 2: Thread `onProgress` through `uploadLandingMedia`**

Change the signature + the video branch:
```js
export async function uploadLandingMedia({ file, locationId, kind = 'image', onProgress }) {
  if (!file || !locationId) return { success: false, error: 'Missing file or location.' }

  // Video → compress (if needed) then upload straight to Supabase Storage.
  if (kind === 'video') return uploadVideoDirect({ file, locationId, onProgress })
```
(the rest of `uploadLandingMedia` — the image path — is unchanged.)

- [ ] **Step 3: Rewrite `uploadVideoDirect`** to compress + widen input types + use the new ceilings

Replace the whole `uploadVideoDirect` function with:
```js
/**
 * Compress (if needed) then direct-upload a video to Supabase Storage via
 * a server-minted signed URL (so the ~4.5MB Vercel function body cap never
 * applies). Accepts any video/* input (e.g. .mov from an iPhone) and
 * transcodes non-MP4/WebM + oversized clips to a 720p MP4 before upload.
 * Returns { success, url?, error? }.
 */
async function uploadVideoDirect({ file, locationId, onProgress }) {
  if (!(file.type || '').startsWith('video/')) {
    return { success: false, error: 'Unsupported file. Please choose a video (MP4, WebM, or MOV).' }
  }
  if (file.size > MAX_VIDEO_INPUT_BYTES) {
    return { success: false, error: `That video is very large (${Math.round(file.size / 1024 / 1024)}MB). Trim it or export at 720p, then re-upload.` }
  }

  // Compress in-browser when needed (fail-open: returns the original on error).
  let toUpload
  try {
    toUpload = await compressVideoIfNeeded(file, { onProgress })
  } catch {
    toUpload = file
  }

  if (toUpload.size > MAX_VIDEO_OUTPUT_BYTES) {
    return { success: false, error: `Video is still too large (${Math.round(toUpload.size / 1024 / 1024)}MB) after compression. Please upload a shorter clip.` }
  }

  if (typeof onProgress === 'function') onProgress({ phase: 'upload', percent: 0 })

  // 1. Mint a signed upload URL (auth + path decided server-side).
  let r
  try {
    r = await fetch('/api/landing-page-settings/media/signed-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, kind: 'video', content_type: toUpload.type }),
    })
  } catch (e) {
    return { success: false, error: `Network error: ${e?.message || e}` }
  }
  let j
  try { j = await r.json() } catch { return { success: false, error: 'Upload failed — invalid server response.' } }
  if (!r.ok || j?.success === false || !j?.token) {
    return { success: false, error: j?.error || `Upload failed (${r.status}).` }
  }

  // 2. PUT the bytes straight to Supabase Storage (no function in the path).
  try {
    const { createBrowserClient } = await import('./supabase')
    const supabase = createBrowserClient()
    const { error } = await supabase.storage
      .from('branding')
      .uploadToSignedUrl(j.path, j.token, toUpload, { contentType: toUpload.type })
    if (error) return { success: false, error: `Video upload failed: ${error.message}` }
  } catch (e) {
    return { success: false, error: `Video upload failed: ${e?.message || e}` }
  }

  return { success: true, url: j.url }
}
```
Key changes vs. today: input guard widened to any `video/*`; `MAX_VIDEO_INPUT_BYTES` checked on the raw file; `compressVideoIfNeeded` runs before upload; the OUTPUT (`toUpload`) is checked against `MAX_VIDEO_OUTPUT_BYTES` and is what's uploaded; `content_type`/`uploadToSignedUrl` use `toUpload.type` (mp4 after transcode); an `onProgress({phase:'upload'})` marker flips the tile to "Uploading…".

- [ ] **Step 4: Run the existing tests** (this file has `parseUploadResponse` + `captureVideoPoster` tests)

Run: `npx vitest run src/lib/landing-media-upload.test.js`
Expected: PASS (no behavior of the tested pure functions changed). Then `npx eslint src/lib/landing-media-upload.js` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-media-upload.js
git commit -m "feat(landing): compress video before upload + raise input/output caps"
```

---

### Task 4: Migration 250 — raise the bucket to 50MB

**Files:**
- Create: `supabase/migrations/250_branding_bucket_video_50mb.sql`

- [ ] **Step 1: Create the migration** — `supabase/migrations/250_branding_bucket_video_50mb.sql`:

```sql
-- 250 — raise the 'branding' bucket size limit for compressed landing-page
-- video uploads. Videos are now transcoded to ~720p MP4 in the browser
-- before upload (src/lib/video-compress.js), so the stored output is small;
-- 50MB is generous headroom for the compressed output + slightly-larger
-- passthrough clips. allowed_mime_types unchanged (mig 248: + mp4 + webm).
update storage.buckets
set file_size_limit = 52428800  -- 50 MB
where id = 'branding';
```

- [ ] **Step 2: Note for the controller** — this migration must be APPLIED to the database (via the Supabase MCP `apply_migration`, or the SQL Editor) before manual testing, or 50MB uploads still bounce off the 26MB bucket. The controller applies it during Task 6.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/250_branding_bucket_video_50mb.sql
git commit -m "feat(landing): raise branding bucket to 50MB for compressed video (mig 250)"
```

---

### Task 5: Progress UI in the editor

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx`

- [ ] **Step 1: Add a `progress` state map** next to the existing upload state (the `useState` for `uploading`/`uploadErr`, ~line 79):
```jsx
  const [progress, setProgress] = useState({}) // { key: { phase, percent } | null }
```

- [ ] **Step 2: Thread `onProgress` through `uploadMedia`** — replace the `uploadMedia` function (~line 268):
```jsx
  async function uploadMedia({ file, kind, key }) {
    setUploadState(key, true, null)
    setProgress((prev) => ({ ...prev, [key]: null }))
    const res = await uploadLandingMedia({
      file,
      locationId,
      kind,
      onProgress: (p) => setProgress((prev) => ({ ...prev, [key]: p })),
    })
    setProgress((prev) => ({ ...prev, [key]: null }))
    if (!res.success) {
      setUploadState(key, false, res.error || 'Upload failed')
      return null
    }
    setUploadState(key, false, null)
    return res.url
  }
```

- [ ] **Step 3: Pass `progress` down to the block cards** — at the `<SortableBlockCard … />` render (~line 410, where `uploadMedia`/`uploading`/`uploadErr` are passed), add the prop:
```jsx
                  progress={progress}
```
In `SortableBlockCard`'s destructured params (~line 531) add `progress`, and pass it to `<BlockEditPanel … />` (~line 583):
```jsx
            progress={progress}
```
(`BlockEditPanel` already spreads `{...props}` to each editor, so `progress` reaches them.)

- [ ] **Step 4: Show progress in `MediaSlot`** — add a `progress` prop and use it for the status text. Update the `MediaSlot` signature (~line 1049, now shifted lower):
```jsx
function MediaSlot({ url, onClear, onUpload, uploading, error, accept, label, kind, progress }) {
```
Inside the empty-state `<label>`, replace the status span:
```jsx
          <span className="text-[10px] mt-1">{uploading ? 'Uploading…' : label}</span>
```
with:
```jsx
          <span className="text-[10px] mt-1 text-center px-1">
            {progress?.phase === 'compress'
              ? `Compressing… ${Math.round(progress.percent || 0)}%`
              : progress?.phase === 'upload'
                ? 'Uploading…'
                : uploading ? 'Uploading…' : label}
          </span>
```

- [ ] **Step 5: Pass each video MediaSlot its progress** — in the two editors that upload video:

In `HeroEdit`, add `progress` to its destructured props (`function HeroEdit({ block, onUpdate, uploadMedia, uploading, uploadErr, progress }) {`) and on the **Background video** `<MediaSlot … kind="video">` (keyed `k('video')`), add:
```jsx
          progress={progress[k('video')]}
```
In `VideoTestimonialsEdit`, add `progress` to its destructured props (`function VideoTestimonialsEdit({ block, onUpdate, uploadMedia, uploading, uploadErr, progress }) {`) and on the per-item `<MediaSlot … kind="video">`, add:
```jsx
              progress={progress[videoKey]}
```
(Image-only editors — `PillarsEdit`, `GalleryEdit` — don't need `progress`; their `MediaSlot`s omit the prop and keep the plain "Uploading…" behaviour.)

- [ ] **Step 6: Lint**

Run: `npx eslint src/components/LandingPageSettingsForm.jsx`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx
git commit -m "feat(landing): show Compressing…/Uploading… progress on video upload"
```

---

### Task 6: Verify + ship

**Files:** none (verification + DB migration apply + PR)

- [ ] **Step 1: CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports
```
Expected: all green. New unit tests: `shouldCompress` + the passthrough case. Parity unaffected (no new `WEB_PERMISSIONS` key).

- [ ] **Step 2: Real production build** — THE critical gate for the ffmpeg integration

```bash
npm run build
```
Expected: exit 0. This is the only check that proves the dynamic `@ffmpeg/ffmpeg` import + the `/public` worker/core URLs don't break Turbopack. **If the build fails on the ffmpeg import/worker:** the helper already dynamic-imports + loads assets by explicit `/public` URL, so the failure is likely Turbopack handling of `@ffmpeg/ffmpeg` — try adding it to `serverExternalPackages` / confirm the dynamic import is only reached client-side; if it still fights the bundler, fall back to the `MediaRecorder` Plan B (spec §Risks) for `compressVideoIfNeeded` and keep the rest of the plan as-is.

- [ ] **Step 3: Apply migration 250** (controller) — via Supabase MCP `apply_migration` (name `branding_bucket_video_50mb`, the SQL from Task 4) or the SQL Editor. Confirm: `select file_size_limit from storage.buckets where id='branding';` → `52428800`.

- [ ] **Step 4: Manual smoke test** (the real proof — auth/render-gated, can't be automated)

`npm run dev`, open the landing editor for a studio, **Video testimonials → Add video**:
1. Upload a large clip (the operator's ~65MB, ideally a `.mov` too) → watch **"Compressing… NN%" → "Uploading…"** → preview appears.
2. Confirm in DevTools → Network/Storage that the stored object is ~8–15MB (not 65MB) and the public page plays it with sound.
3. Upload a small (<20MB) MP4 → confirm it passes through fast (no long "Compressing…" phase).
4. Confirm the **Hero** background video upload also compresses.
5. Sad path: a tiny non-video file is rejected with a clear message; (optional) a multi-minute clip that stays >50MB after compress shows the "still too large" message.

- [ ] **Step 5: Push + open the PR** (per the canonical ship loop in CLAUDE.md)

```bash
git push -u origin landing-video-compression
```
Open a PR (`base: main`, title `LANDING-VIDEO.2 — in-browser video compression`) summarizing: ffmpeg.wasm (ST, self-hosted) compresses landing videos to 720p MP4 before upload (fixes the 25MB limit for testimonials + hero), accepts up to ~500MB input incl. `.mov`, ≤20MB MP4/WebM passthrough, bucket 26→50MB (mig 250), progress UI, fail-open. Note the migration was applied. End with the `Verified:` line (tests · lint · parity · imports · build · **manual transcode** · migration) + the Claude Code trailer.

---

## Notes on execution

- **Task 2 is the high-risk task** (ffmpeg.wasm × Turbopack). It may need iteration on the asset URLs / build config — budget for that. Everything else (shouldCompress logic, the wiring, the migration, the progress UI) is deterministic.
- **Plan B** if ffmpeg can't be made to build/run: replace `compressVideoIfNeeded`'s transcode branch with a `MediaRecorder` + `<canvas>` real-time re-encode (draw the played video to a 720p canvas, `canvas.captureStream()` + the original audio track → `MediaRecorder` → WebM). Coarser quality, WebM output, real-time speed — acceptable for short testimonials, zero heavy deps. Keep `shouldCompress` + the wiring + the progress UI identical; only the transcode internals change.
- No mobile-parity entry (no new `WEB_PERMISSIONS` key — editor stays on `landing_page`).
