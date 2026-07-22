import localFont from 'next/font/local'

// Self-hosted Poppins (AUDIT 2026-07 — was next/font/google). Moving to
// next/font/local removes the build-time fetch to fonts.googleapis.com so the
// build is hermetic: a Google outage previously failed `next build`. The
// latin-subset .woff2 files are committed alongside this module.
//
// Two exports preserve the two prior Poppins() call sites exactly:
//   - poppinsBody: the public brand surfaces (event/welcome/host/technical),
//     exposed as the --font-body CSS variable, weights 400-800.
//   - poppinsTv:   the TV template face (tv-font.js), weights 400/600/700/800/900.
//
// next/font requires statically-analyzable literal options — the src arrays
// below must stay fully written out (no helpers/variables).

export const poppinsBody = localFont({
  src: [
    { path: './poppins-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './poppins-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './poppins-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './poppins-latin-700-normal.woff2', weight: '700', style: 'normal' },
    { path: './poppins-latin-800-normal.woff2', weight: '800', style: 'normal' },
  ],
  variable: '--font-body',
  display: 'swap',
})

export const poppinsTv = localFont({
  src: [
    { path: './poppins-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './poppins-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './poppins-latin-700-normal.woff2', weight: '700', style: 'normal' },
    { path: './poppins-latin-800-normal.woff2', weight: '800', style: 'normal' },
    { path: './poppins-latin-900-normal.woff2', weight: '900', style: 'normal' },
  ],
  display: 'swap',
})
