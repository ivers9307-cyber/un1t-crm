// src/components/icons/InstagramIcon.jsx
//
// Drop-in replacement for lucide-react's `Instagram` — lucide 1.x removed
// every brand icon, so this glyph lives here now. Same drawing as the
// channel logo in inbox/ChannelBits.jsx (kept separate: that one is
// channel-keyed and private to the inbox), with lucide's prop surface
// (`size`, `className`, `strokeWidth`, ...rest spread onto the <svg>) so
// existing call sites don't change.
export function Instagram({ size = 24, strokeWidth = 2, className = '', ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.6" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
