// Reveal arming — server-renderable inline script for the public
// landing pages. Runs synchronously during HTML parse (before first
// paint) and adds `lp-armed` to the #lp-shell wrapper (owned by
// src/app/welcome/layout.js) so `.lp-reveal` elements start hidden
// with zero flash. RevealManager (the client island) then reveals
// them on scroll.
//
// Static constant, no interpolation anywhere. Written WITHOUT the
// characters `&`, `<`, `>` so it can be rendered as a plain JSX text
// child of <script> (React escapes those in text nodes, which would
// corrupt the code). Keep it that way if you edit it: use nested ifs,
// not boolean operators.
//
// Guards: reduced-motion users and browsers without
// IntersectionObserver are never armed — they get static, fully
// visible content. Edit mode (?edit=1) simply doesn't render this.

const ARM_CODE =
  "try{var m=window.matchMedia('(prefers-reduced-motion: no-preference)');if(m.matches){if('IntersectionObserver' in window){var s=document.getElementById('lp-shell');if(s){s.classList.add('lp-armed')}}}}catch(e){}"

export function RevealArmScript() {
  return <script>{ARM_CODE}</script>
}
