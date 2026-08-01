import localFont from 'next/font/local'

// Self-hosted Graft/Afterglow board faces (GRAFT-TV 2026-08). Same rationale
// as poppins.js: next/font/local keeps the build hermetic — no build-time
// fetch to fonts.googleapis.com, so a Google outage can't fail `next build`.
// The .woff2 files are committed alongside this module.
//
// These are the public TV-board faces of the Graft/Afterglow system:
//   - graftDisplay: Archivo Expanded (static instances 600/700/800) — headings
//     and earned numbers (BPM, points, ranks-as-heroes, countdowns).
//   - graftBody:    Figtree (VARIABLE font, one file spanning 300–900) —
//     names and labels.
//   - graftMono:    IBM Plex Mono (400/500) — telemetry: kickers, clocks,
//     units, chips (uppercase, letterspaced).
//
// next/font requires statically-analyzable literal options — the src arrays
// below must stay fully written out (no helpers/variables).

export const graftDisplay = localFont({
  src: [
    { path: './archivo-expanded-600.woff2', weight: '600', style: 'normal' },
    { path: './archivo-expanded-700.woff2', weight: '700', style: 'normal' },
    { path: './archivo-expanded-800.woff2', weight: '800', style: 'normal' },
  ],
  variable: '--font-graft-display',
  display: 'swap',
})

export const graftBody = localFont({
  src: [
    { path: './figtree-latin-variable.woff2', weight: '300 900', style: 'normal' },
  ],
  variable: '--font-graft-body',
  display: 'swap',
})

export const graftMono = localFont({
  src: [
    { path: './plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-graft-mono',
  display: 'swap',
})
