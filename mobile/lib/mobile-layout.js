// Resolve a user's effective mobile layout (bottom bar + More) at their
// active location. Computes the enabled nav-feature set with the SAME
// permission helpers the screens already use (canMobile routes cross-platform
// keys like studio_management through canDashboard), reads the per-assignment
// override from the serialized permissions blob, and runs the shared resolver.
import { MOBILE_NAV_FEATURES, resolveMobileLayout } from '../../shared/mobile-nav'
import { canMobile } from './permissions'

function navFeatureEnabled(profile, feature, activeLocation) {
  if (feature.employmentType && profile?.employment_type !== feature.employmentType) return false
  return feature.permKeys.some(k => canMobile(profile, k, activeLocation))
}

/**
 * @param {object|null} profile         from /api/mobile/me
 * @param {object|null} activeLocation  has .permissions.mobile.layout + .permissions + .features
 * @returns {{ bar: string[], more: string[], allowed: string[] }}
 */
export function resolveLayoutForUser(profile, activeLocation) {
  if (!profile) return { bar: [], more: [], allowed: [] }
  const enabledKeys = MOBILE_NAV_FEATURES
    .filter(f => navFeatureEnabled(profile, f, activeLocation))
    .map(f => f.key)
  const override = activeLocation?.permissions?.mobile?.layout || null
  return resolveMobileLayout({
    role: profile.role,
    employmentType: profile.employment_type,
    enabledKeys,
    override,
    staffBar: activeLocation?.staffBar || null,
  })
}
