// Full-screen lock overlay. Absolute-fill on top of the app (which stays
// mounted underneath). `checking` shows a neutral cover while the stored pref
// is read (no flash of app content). Sign out is the escape hatch so a failed
// biometric never permanently locks someone out.
//
// LOADER.1 — the surface is Repset INK (#131316), the same colour as
// splash.png's background, so the native splash and this overlay read as one
// continuous moment instead of splash → white flash → app. The `checking`
// state is the branded <RepsetLoader /> rather than a stock ActivityIndicator.
//
// COLOURS ARE EXPLICIT HEX ON PURPOSE: the mobile Tailwind palette is a LIGHT
// theme (`un1t-bg` is #FFFFFF, `un1t-text` is near-black), so those tokens are
// exactly wrong on an ink surface — using them here would render white-on-white.
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import RepsetLoader, { REPSET_INK } from './RepsetLoader'

const BONE = '#F2F0EB' // primary text on ink
const BONE_SUBTLE = '#8E8E96' // secondary text on ink
const VOLT = '#D6F84C' // primary action

export default function LockScreen({ typeLabel, checking, onUnlock }) {
  const { signOut } = useAuth()
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: REPSET_INK }]}
      className="items-center justify-center px-8"
    >
      {checking ? (
        <RepsetLoader size={104} />
      ) : (
        <>
          <Text style={{ color: BONE }} className="text-3xl font-bold mb-2">Repset</Text>
          <Text style={{ color: BONE_SUBTLE }} className="text-sm mb-8 text-center">
            Locked. Unlock with {typeLabel} to continue.
          </Text>
          <Pressable onPress={onUnlock}
            style={{ backgroundColor: VOLT }}
            className="flex-row items-center justify-center rounded-2xl px-6 py-3.5 active:opacity-80">
            <Ionicons name="lock-open-outline" size={18} color={REPSET_INK} />
            <Text style={{ color: REPSET_INK }} className="text-base font-semibold ml-2">
              Unlock with {typeLabel}
            </Text>
          </Pressable>
          <Pressable onPress={signOut} className="mt-4 py-2 active:opacity-70">
            <Text style={{ color: BONE_SUBTLE }} className="text-sm">Sign out</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}
