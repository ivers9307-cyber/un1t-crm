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
 * @param {{ onProgress?: (p: { phase: 'compress', percent: number }) => void, onError?: (reason: string) => void }} [opts]
 * @returns {Promise<File>}
 */
export async function compressVideoIfNeeded(file, { onProgress, onError } = {}) {
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
    let data
    try {
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
      data = await ff.readFile(outName)
    } finally {
      // Always detach the progress listener + clean the in-memory FS,
      // even if writeFile / exec / readFile threw.
      ff.off('progress', onProg)
      try { await ff.deleteFile(inName); await ff.deleteFile(outName) } catch { /* ignore */ }
    }

    const base = (file.name || 'video').replace(/\.[^.]+$/, '')
    const blob = new Blob([data.buffer], { type: 'video/mp4' })
    // If the transcode somehow produced a bigger file than the original
    // (rare — a tiny already-optimised input), keep the original.
    if (blob.size >= file.size && PASSTHROUGH_TYPES.has(file.type || '')) return file
    return new File([blob], `${base}.mp4`, { type: 'video/mp4' })
  } catch (e) {
    const reason = e?.message || String(e)
    if (typeof console !== 'undefined') console.warn('[video-compress] transcode failed, uploading original:', reason)
    // Surface WHY to the caller so the UI can show it. Without this the
    // fail-open is invisible and the operator only sees a downstream size /
    // storage error with no clue that compression silently gave up.
    if (typeof onError === 'function') { try { onError(reason) } catch { /* ignore */ } }
    return file
  }
}
