// Mirrors the intent-based un1t-* token names in
// /tailwind.config.js (web, renamed in UI-FOUND.1) so a component
// referencing bg-un1t-surface renders the same on both platforms.
// Hex values are unchanged; the names are no longer inverted
// (previously 'un1t-black' held #FFFFFF — a class that lied about
// its colour). MOB-UI.1.

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        'un1t-bg': '#FFFFFF',       // was 'un1t-black'  — page background
        'un1t-surface': '#F7F8FA',  // was 'un1t-dark'   — cards / raised
        'un1t-border': '#E2E5E9',   // was 'un1t-gray'   — hairlines
        'un1t-muted': '#94A3B8',    // was 'un1t-mid'    — secondary text
        'un1t-subtle': '#64748B',   // was 'un1t-light'  — tertiary text
        'un1t-text': '#111827',     // was 'un1t-white'  — primary text
        'un1t-accent': '#1E293B',
        // ── PHASE2 (one-app merge) — Afterglow (Graft) tokens, ported
        // verbatim from champ-app/mobile/tailwind.config.js (spec
        // 2026-08-01-graft-afterglow-design.md). Member-app screens use
        // these; staff screens stay on un1t-*. Zero key overlap. ──
        'iron-bg': '#0F1216',       // cool graphite canvas (not neutral black)
        'iron-surface': '#181D24',
        'iron-raised': '#202730',
        'iron-hairline': '#2A323D',
        chalk: '#F4F1EA',           // primary text — never pure #FFF
        'chalk-2': '#A9B0BA',
        'chalk-3': '#66707E',
        pearl: '#D9D5CC',           // resting accent (unlit state)
      },
      fontFamily: {
        sans: ['System'],
        // ── PHASE2 — Graft (Afterglow) type system, ported from champ.
        // Two-tier numeral rule: `display*` = EARNED numbers + headings
        // (Archivo Expanded, wdth 125 instanced TTFs); `mono` =
        // body-sourced telemetry ONLY (bpm, minutes, timestamps).
        // Body = Figtree. Fonts loaded by the member-app tree. ──
        display: ['ArchivoExpanded-SemiBold'],
        'display-bold': ['ArchivoExpanded-Bold'],
        'display-black': ['ArchivoExpanded-Black'],
        body: ['Figtree_400Regular'],
        'body-medium': ['Figtree_500Medium'],
        'body-semibold': ['Figtree_600SemiBold'],
        mono: ['IBMPlexMono_500Medium'],
      },
    },
  },
  plugins: [],
}
