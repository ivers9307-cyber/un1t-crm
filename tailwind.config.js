/** @type {import('tailwindcss').Config} */
module.exports = {
  // `shared/` is included so Tailwind picks up class strings used by
  // shared helpers (e.g. shared/location-colors.js — chip palette
  // imported by both web and mobile). Without this entry the JIT
  // compiler never sees those classes and they render unstyled.
  content: ['./src/**/*.{js,jsx}', './shared/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        un1t: {
          // Intent-based tokens (UI-FOUND.1). Names previously meant
          // their opposite (e.g. `black` held #FFFFFF) after a
          // dark→light retrofit; renamed so a class never lies about
          // its colour. Hex values unchanged — pure rename.
          bg: '#FFFFFF',       // was `black`  — page background
          surface: '#F7F8FA',  // was `dark`   — cards / raised
          border: '#E2E5E9',   // was `gray`   — hairlines
          muted: '#94A3B8',    // was `mid`    — secondary text
          subtle: '#64748B',   // was `light`  — tertiary text
          text: '#111827',     // was `white`  — primary text
          accent: '#1E293B',
        },
        stage: {
          new: '#3B82F6',
          social: '#8B5CF6',
          trial: '#10B981',
          conversion: '#F59E0B',
          followup: '#EF4444',
          member: '#059669',
          cold: '#9CA3AF',
          lost: '#DC2626',
          returning: '#6366F1',
        }
      }
    }
  },
  plugins: [],
}
