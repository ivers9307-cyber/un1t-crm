// Emit the publishable WhatsApp Flow JSON for the "Book your first visit" Flow
// from FLOW_JSON (src/lib/whatsapp-flow/screens.js), optionally base64-embedding
// a header image at the top of the PATH screen (Flow JSON can't reference hosted
// URLs — image bytes must live inside the JSON).
//
// Usage:
//   node scripts/build-flow-json.mjs [--header <image.jpg>] [--out flow.json]
//
// Keep the header image small — a ~640px-wide JPEG (<~60 KB) is plenty; large
// images bloat the Flow and can exceed Meta's limits. Paste the output into
// WhatsApp Flow Builder's JSON editor.
import { readFileSync, writeFileSync } from 'node:fs'
import { FLOW_JSON } from '../src/lib/whatsapp-flow/screens.js'

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

const headerPath = arg('--header')
const outPath = arg('--out') || 'flow.json'

const flow = JSON.parse(JSON.stringify(FLOW_JSON))

if (headerPath) {
  const b64 = readFileSync(headerPath).toString('base64')
  const pathScreen = flow.screens.find((s) => s.id === 'PATH')
  pathScreen.layout.children.unshift({
    type: 'Image',
    src: b64,
    height: 200,
    'scale-type': 'cover',
    'alt-text': 'UN1T Stillorgan',
  })
}

const json = JSON.stringify(flow, null, 2)
writeFileSync(outPath, json)
console.log(`wrote ${outPath}${headerPath ? ` (+ header ${headerPath})` : ''} — ${Math.round(json.length / 1024)} KB`)
