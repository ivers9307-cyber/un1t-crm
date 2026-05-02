// Deterministic location → chip-colour mapping.
//
// Used by the personal-dashboard shift rows on web and mobile so a
// multi-location user can tell at a glance which gym a shift belongs
// to. Pure function — same location_id always returns the same
// palette key, no DB lookup, no admin UI needed.
//
// Why a hash instead of a `locations.color` column?
// We have ≤8 locations today and the user just needs the two on
// screen to look distinct. The hash gives us that for free; if we
// ever want to let owners pin a brand colour per studio, we can
// add a `locations.color` field and `pickLocationColor()` can prefer
// it before falling back to the hash. Until then, no schema work.
//
// Palette is fixed at 10 colours so Tailwind's JIT compiler can see
// every class string at build time (template-literal-built classes
// don't get picked up). Each entry has a `bg` and `text` chosen for
// readability on the LIGHT theme this app uses — `-500/20` tint
// background plus `-700` text for sufficient contrast, matching the
// existing DRAFT-badge style already used in the codebase.
// NativeWind uses the same Tailwind strings so the same palette
// renders on iOS too.
//
// Tailwind's `content` glob in tailwind.config.js MUST include
// `shared/**` for these classes to get compiled — otherwise JIT
// strips them and the chips render unstyled.

export const LOCATION_CHIP_PALETTE = Object.freeze([
  { key: 'blue',    bg: 'bg-blue-500/20',    text: 'text-blue-700'    },
  { key: 'emerald', bg: 'bg-emerald-500/20', text: 'text-emerald-700' },
  { key: 'purple',  bg: 'bg-purple-500/20',  text: 'text-purple-700'  },
  { key: 'amber',   bg: 'bg-amber-500/20',   text: 'text-amber-700'   },
  { key: 'rose',    bg: 'bg-rose-500/20',    text: 'text-rose-700'    },
  { key: 'cyan',    bg: 'bg-cyan-500/20',    text: 'text-cyan-700'    },
  { key: 'violet',  bg: 'bg-violet-500/20',  text: 'text-violet-700'  },
  { key: 'orange',  bg: 'bg-orange-500/20',  text: 'text-orange-700'  },
  { key: 'teal',    bg: 'bg-teal-500/20',    text: 'text-teal-700'    },
  { key: 'pink',    bg: 'bg-pink-500/20',    text: 'text-pink-700'    },
])

// FNV-1a 32-bit. Stable, fast, no deps. Good enough distribution
// across the palette for UUID-shaped inputs.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // Math.imul keeps it in 32-bit signed range — same as `* 16777619` in C.
    h = Math.imul(h, 0x01000193)
  }
  // Coerce to unsigned for a non-negative modulo.
  return h >>> 0
}

/**
 * Pick a stable palette entry for a location.
 *
 * @param {string | null | undefined} locationId
 * @returns {{ key: string, bg: string, text: string }}
 */
export function pickLocationColor(locationId) {
  if (!locationId) return LOCATION_CHIP_PALETTE[0]
  const idx = fnv1a(String(locationId)) % LOCATION_CHIP_PALETTE.length
  return LOCATION_CHIP_PALETTE[idx]
}
