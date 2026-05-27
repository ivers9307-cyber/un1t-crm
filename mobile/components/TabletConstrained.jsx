// STUDIO-IPAD.3 — content-width constraint for list / single-column
// screens on iPad.
//
// On iPhone (320–430pt) the existing screens fill the width
// edge-to-edge, which is right at phone scale. On iPad the same
// layouts span 768pt+ which leaves rows stretched to absurd width
// and the eye has to track all the way across to find the action
// affordance on the right.
//
// This wrapper does ONE thing: on tablet widths, constrains the
// inner content to TABLET_CONTENT_MAX_PT (720pt) and centers it
// horizontally. On phone widths it's a no-op pass-through — same
// edge-to-edge rendering as before.
//
// Per design-doc rationale: most screens look "stretched but
// functional" on iPad without changes. This makes them look
// intentionally laid out without restructuring navigation or pulling
// detail content inline (the master-detail work that would require
// per-screen detail-component extraction).
//
// Usage: wrap the ScrollView (or whatever the screen's content root
// is). For ScrollView specifically, prefer wrapping the OUTER View
// and letting the ScrollView own the inner content — that way pull-
// to-refresh + RefreshControl still hit the right scroll surface.

import { View } from 'react-native'
import { useIsTablet } from '../lib/use-is-tablet'

export const TABLET_CONTENT_MAX_PT = 720

/**
 * Constrains its children to TABLET_CONTENT_MAX_PT max-width and
 * centers them, but only when the viewport is in tablet territory.
 *
 * Pass `className` through to the wrapping View so callers can keep
 * their existing background + flex styles.
 *
 * @param {{ children?: any, className?: string, style?: any }} props
 */
export default function TabletConstrained({ children, className, style }) {
  const isTablet = useIsTablet()
  if (!isTablet) {
    return (
      <View className={className} style={style}>
        {children}
      </View>
    )
  }
  return (
    <View className={className} style={style}>
      <View
        // Tailwind doesn't carry an arbitrary self-center+max-width
        // class chain cleanly without our usual config, so set it
        // inline. width: '100%' is needed so the inner View doesn't
        // collapse to its content; maxWidth caps it; alignSelf centers
        // the constrained block inside the (full-width) outer flex.
        style={{
          width: '100%',
          maxWidth: TABLET_CONTENT_MAX_PT,
          alignSelf: 'center',
          flex: 1,
        }}
      >
        {children}
      </View>
    </View>
  )
}
