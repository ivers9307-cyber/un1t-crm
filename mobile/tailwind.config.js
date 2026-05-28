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
      },
      fontFamily: {
        sans: ['System'],
      },
    },
  },
  plugins: [],
}
