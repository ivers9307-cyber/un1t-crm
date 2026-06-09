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
