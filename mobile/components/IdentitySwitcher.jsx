// PHASE2 stage C — the dual-identity switcher (approved mockups). Renders
// a small avatar with a volt-dot badge in the shell header for DUAL
// (staff+member) users only; tapping opens the identity sheet with a
// "Staff · <location> / <role>" card and a "Personal — Member" card. One
// tap on the other card persists the side and replaces to the other
// shell's home.
//
// Guards (locked): kiosk-paired and impersonating sessions NEVER render
// the switcher (the resolver already suppresses member mode for both;
// this component re-checks as defence). Single-identity users render
// nothing — both shells look exactly as they did pre-merge.

import { useState } from 'react'
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import { useIdentity } from '../lib/identity-context'
import { routeForSide } from '../lib/last-side'
import { VOLT, IRON_SURFACE, IRON_HAIRLINE, CHALK, CHALK_2 } from '../lib/member/brand'

const VOLT_DOT = 9

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '•'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

function roleLabel(role) {
  if (!role) return 'Staff'
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/**
 * @param {{ side: 'staff'|'member' }} props Which shell's header hosts this
 *   instance — themes the avatar + sheet and marks the current card.
 */
export default function IdentitySwitcher({ side }) {
  const { profile, activeLocation } = useAuth()
  const identity = useIdentity()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // Kiosk / impersonation: never render. Non-dual: nothing to switch.
  if (identity.paired || identity.impersonating || !identity.dual) return null

  const dark = side === 'member'
  const staffName = profile?.full_name || profile?.email
  const memberName = identity.contact?.name
  const avatarName = side === 'staff' ? (staffName || memberName) : (memberName || staffName)

  const staffSubtitle = [activeLocation?.name, roleLabel(profile?.role)].filter(Boolean).join(' / ')

  function switchTo(target) {
    setOpen(false)
    if (target === side) return
    identity.setSide(target) // persists repset_last_side
    router.replace(routeForSide(target))
  }

  const cardBase = {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  }

  function IdentityCard({ target, title, subtitle, icon }) {
    const current = target === side
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={current ? `${title} — current` : `Switch to ${title}`}
        onPress={() => switchTo(target)}
        style={{
          ...cardBase,
          backgroundColor: dark ? (current ? '#24242A' : IRON_SURFACE) : (current ? '#F1F5F9' : '#FFFFFF'),
          borderColor: current ? VOLT : (dark ? IRON_HAIRLINE : '#E2E5E9'),
        }}
      >
        <Ionicons name={icon} size={20} color={dark ? CHALK_2 : '#64748B'} style={{ marginRight: 12 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: dark ? CHALK : '#111827' }}>{title}</Text>
          {!!subtitle && (
            <Text style={{ fontSize: 12, marginTop: 2, color: dark ? CHALK_2 : '#64748B' }}>{subtitle}</Text>
          )}
        </View>
        {current && <Ionicons name="checkmark-circle" size={20} color={VOLT} />}
      </TouchableOpacity>
    )
  }

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Switch identity"
        onPress={() => setOpen(true)}
        style={{ marginRight: 12 }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: dark ? IRON_SURFACE : '#E2E8F0',
            borderWidth: 1,
            borderColor: dark ? IRON_HAIRLINE : '#CBD5E1',
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: '700', color: dark ? CHALK : '#334155' }}>
            {initialsOf(avatarName)}
          </Text>
          {/* Volt dot — the dual-identity badge. Ring matches the header
              ground so the dot reads as sitting ON the avatar. */}
          <View
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: VOLT_DOT + 4,
              height: VOLT_DOT + 4,
              borderRadius: (VOLT_DOT + 4) / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: dark ? '#131316' : '#FFFFFF',
            }}
          >
            <View style={{ width: VOLT_DOT, height: VOLT_DOT, borderRadius: VOLT_DOT / 2, backgroundColor: VOLT }} />
          </View>
        </View>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Scrim — tap anywhere outside the sheet to dismiss. */}
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }} onPress={() => setOpen(false)}>
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: dark ? '#131316' : '#FFFFFF',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 16,
              paddingBottom: 36,
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 36,
                height: 4,
                borderRadius: 2,
                marginBottom: 14,
                backgroundColor: dark ? IRON_HAIRLINE : '#E2E8F0',
              }}
            />
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                marginBottom: 12,
                color: dark ? CHALK_2 : '#64748B',
              }}
            >
              Your identities
            </Text>
            <IdentityCard
              target="staff"
              title={`Staff${staffName ? ` · ${staffName}` : ''}`}
              subtitle={staffSubtitle}
              icon="business-outline"
            />
            <IdentityCard
              target="member"
              title="Personal — Member"
              subtitle={memberName || undefined}
              icon="pulse-outline"
            />
            <Text style={{ fontSize: 12, textAlign: 'center', marginTop: 6, color: dark ? CHALK_2 : '#94A3B8' }}>
              Switching is instant — you stay signed in.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}
