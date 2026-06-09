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
// IMPORTANT: copy the ESM core (NOT umd). The @ffmpeg/ffmpeg worker runs as a
// `type:"module"` worker and loads the core via `(await import(coreURL)).default`
// (worker.js — importScripts throws in a module worker, so it falls to the
// dynamic-import branch). The UMD build has NO `export default` (it assigns a
// global, for importScripts), so the module worker gets `.default === undefined`
// → ERROR_IMPORT_FAILURE → ffmpeg never loads and video uploads silently
// fail-open. The ESM build has `export default createFFmpegCore`. worker.js is
// the module worker itself.
const assets = [
  ['node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js',   'ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
  // worker.js is an ES module that imports its two leaf siblings; self-host
  // all three so the worker's `import './const.js'` / `'./errors.js'` resolve
  // (otherwise they 404 and the module worker never loads — before it ever
  // reaches the core).
  ['node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js',      'worker.js'],
  ['node_modules/@ffmpeg/ffmpeg/dist/esm/const.js',       'const.js'],
  ['node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js',      'errors.js'],
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
