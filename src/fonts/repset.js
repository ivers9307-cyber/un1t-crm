import localFont from 'next/font/local'

// Self-hosted Repset board faces (Repset merge P4a, 2026-08 — formerly the
// Graft/Afterglow module; the three faces are unchanged, only the identity
// is). Same rationale as poppins.js: next/font/local keeps the build
// hermetic — no build-time fetch to fonts.googleapis.com, so a Google outage
// can't fail `next build`. The .woff2 files are committed alongside this
// module.
//
// These are the public TV-board faces of the Repset system:
//   - repsetDisplay: Archivo Expanded (static instances 600/700/800) —
//     headings and earned numbers (BPM, points, ranks-as-heroes, countdowns).
//   - repsetBody:    Figtree (VARIABLE font, one file spanning 300–900) —
//     names and labels.
//   - repsetMono:    IBM Plex Mono (400/500) — telemetry: kickers, clocks,
//     units, chips (uppercase, letterspaced).
//
// next/font requires statically-analyzable literal options — the src arrays
// below must stay fully written out (no helpers/variables).

export const repsetDisplay = localFont({
  src: [
    { path: './archivo-expanded-600.woff2', weight: '600', style: 'normal' },
    { path: './archivo-expanded-700.woff2', weight: '700', style: 'normal' },
    { path: './archivo-expanded-800.woff2', weight: '800', style: 'normal' },
  ],
  variable: '--font-repset-display',
  display: 'swap',
})

export const repsetBody = localFont({
  src: [
    { path: './figtree-latin-variable.woff2', weight: '300 900', style: 'normal' },
  ],
  variable: '--font-repset-body',
  display: 'swap',
})

export const repsetMono = localFont({
  src: [
    { path: './plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-repset-mono',
  display: 'swap',
})
