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
        // ── PHASE2 (one-app merge) member tokens — the NAMES are the
        // historical Afterglow (Graft) vocabulary (iron/chalk/pearl,
        // spec 2026-08-01-graft-afterglow-design.md), kept because the
        // 27 member screens reference them; the VALUES are Repset (P4b,
        // 2026-08-17). Member-app screens use these; staff screens stay
        // on un1t-*. Zero key overlap.
        //   iron-*  — Repset ink: #131316 ground, #1C1C21 raised;
        //             raised/hairline re-derived on the same lightness
        //             steps the Afterglow graphite ramp used.
        //   chalk   — Repset bone #F1EEE7; chalk-2/3 are bone→ink mixes
        //             holding the old secondary/tertiary contrast
        //             (~8.8:1 / ~3.8:1 on the ground).
        //   pearl   — resting (unlit) accent: bone at the same ~89%
        //             per-channel emphasis the Afterglow pearl had to
        //             its chalk. Quiet states NEVER take volt.
        //   volt    — the ONLY lit/earned accent (the app-mark green).
        //   Zone DATA colours live in shared/zone-colors — unchanged. ──
        'iron-bg': '#131316',       // Repset ink ground
        'iron-surface': '#1C1C21',  // raised ink
        'iron-raised': '#24242A',
        'iron-hairline': '#2A2A31',
        chalk: '#F1EEE7',           // primary text (bone) — never pure #FFF
        'chalk-2': '#B3B2AC',
        'chalk-3': '#727170',
        pearl: '#D6D2C9',           // resting accent (unlit state)
        // ── Repset brand signal — the volt-green of the app mark
        // (public/repset-mark.svg). P4b: promoted from switcher-only to
        // THE earned accent of the member surface (lit states only). ──
        volt: '#D6FF3D',
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
