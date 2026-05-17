#!/usr/bin/env bash
# RSC-AUDIT.2 — find files with `'use client'` that don't actually
# use any client-only feature. Run periodically (every few sprints
# / after a refactor wave) to catch accidental directives.
#
# Heuristic markers that REQUIRE client (any one is enough):
#   • React hooks                       — useState/useEffect/useRef/etc. → use*(...)
#   • Next.js client navigation hooks   — useRouter/usePathname/useSearchParams (caught by use*(...))
#   • Event handlers on JSX             — onClick=, onChange=, ... (full list inline below)
#   • Browser globals                   — window./document./localStorage./sessionStorage./navigator.
#   • Browser-only APIs                 — requestAnimationFrame, IntersectionObserver, etc.
#   • DOM ref helpers                   — forwardRef(...), createRef(...)
#   • dangerouslySetInnerHTML           — string-rendered HTML (browser-only)
#
# A file with NONE of these can drop the 'use client' directive AS LONG
# AS no production caller relies on the file being a Client Component
# entry point for bundle-boundary reasons (rare — usually moot).
#
# Usage:
#   bash _rsc_audit.sh
#
# Honest expectation: most CRM components legitimately need 'use client'.
# The interesting candidates are pure-prop pass-through wrappers and
# pure data-transformation panels. The first run found 3 of 130+ files.

set -e
cd "$(dirname "$0")"

candidates=()
for f in $(grep -rl "'use client'" src/ --include='*.jsx' --include='*.js'); do
  if grep -qE 'use[A-Z][A-Za-z]+\s*\(' "$f"; then continue; fi
  if grep -qE 'on(Click|Change|Submit|Focus|Blur|KeyDown|KeyUp|KeyPress|MouseDown|MouseUp|MouseEnter|MouseLeave|MouseMove|Touch[A-Z]|Drag[A-Z]|Drop|Scroll|Wheel|Input|Select|Pointer[A-Z]|Animation[A-Z]|Transition[A-Z]|Load|Error|Resize|Copy|Cut|Paste|ContextMenu|DoubleClick)=' "$f"; then continue; fi
  if grep -qE '\b(window|document|localStorage|sessionStorage|navigator)\.' "$f"; then continue; fi
  if grep -qE '\b(requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval|IntersectionObserver|ResizeObserver|MutationObserver|FileReader|URLSearchParams\s*\()' "$f"; then continue; fi
  if grep -qE '\bdangerouslySetInnerHTML\b' "$f"; then continue; fi
  if grep -qE '\b(forwardRef|createRef)\s*\(' "$f"; then continue; fi
  candidates+=("$f")
done

if [ ${#candidates[@]} -eq 0 ]; then
  echo "RSC audit: clean — no stripable 'use client' directives found."
  exit 0
fi

echo "RSC audit: ${#candidates[@]} candidate(s) for stripping 'use client':"
for f in "${candidates[@]}"; do
  size=$(wc -l < "$f")
  echo "  $f  ($size lines)"
done
echo
echo "Each candidate above:"
echo "  - has no React hooks (useState/useEffect/etc.)"
echo "  - has no event handlers on JSX (onClick=/onChange=/etc.)"
echo "  - has no browser globals (window/document/localStorage/etc.)"
echo "  - has no DOM observers or browser-only timer APIs"
echo "  - has no forwardRef / createRef / dangerouslySetInnerHTML"
echo
echo "Read each file before stripping — the heuristic is conservative but"
echo "not infallible. Anything genuinely client-side that escaped this list"
echo "should be kept with a one-line comment explaining why."
