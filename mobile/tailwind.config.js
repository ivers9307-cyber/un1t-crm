// Mirrors the un1t-* token names in /tailwind.config.js (web) so a
// component referencing bg-un1t-dark renders the same on both. The
// inverted naming (un1t-black = #FFFFFF white background) is preserved
// for parity — see CLAUDE.md "Light theme with inverted token names".

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        'un1t-black': '#FFFFFF',
        'un1t-dark': '#F7F8FA',
        'un1t-gray': '#E2E5E9',
        'un1t-mid': '#94A3B8',
        'un1t-light': '#64748B',
        'un1t-white': '#111827',
        'un1t-accent': '#1E293B',
      },
      fontFamily: {
        sans: ['System'],
      },
    },
  },
  plugins: [],
}
