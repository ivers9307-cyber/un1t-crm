// LEAVEPHONE.1 — the Schedule tab's two floating leave buttons: "My leave"
// (left) and "Request time off" (right).
//
// One absolutely-positioned ROW rather than two independently absolute
// buttons, so they can never draw on top of each other: when they do not fit
// side by side the request label shortens (lib/leave-form.js
// leaveFloatingButtons decides, from the window width and the user's font
// scale), and at the largest accessibility text sizes the row wraps, the
// request button going ABOVE (flex-wrap-reverse) and staying right (ml-auto).
// pointerEvents="box-none": the empty part of the row must not swallow taps
// meant for the shift list underneath. Navigation stays with the screen (it
// owns the router); this only draws the pair.
// AVAIL.3 — for a contractor the request button opens My availability.

import { View, Text, Pressable, useWindowDimensions } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { leaveFloatingButtons } from '../lib/leave-form'

export default function LeaveFloatingButtons({ onMyLeave, onRequest, employmentType }) {
  const { width, fontScale } = useWindowDimensions()
  // AVAIL.3 — for a contractor the right-hand button is "My availability".
  // onRequest gets the route to open; the screen owns the router.
  const b = leaveFloatingButtons({ width, fontScale, employmentType })
  return (
    <View
      pointerEvents="box-none"
      className="absolute bottom-6 left-6 right-6 flex-row flex-wrap-reverse items-center gap-2"
    >
      <Pressable
        onPress={onMyLeave}
        accessibilityRole="button"
        accessibilityLabel={b.myLeaveA11y}
        className="bg-un1t-surface border border-un1t-border rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
      >
        <Ionicons name="list-outline" size={18} color="#111827" />
        <Text className="text-un1t-text font-semibold ml-1.5">{b.myLeaveLabel}</Text>
      </Pressable>
      <Pressable
        onPress={() => onRequest(b.requestTarget)}
        accessibilityRole="button"
        accessibilityLabel={b.requestA11y}
        className="ml-auto bg-un1t-text rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
      >
        <Ionicons name={b.requestIcon} size={20} color="#FFFFFF" />
        <Text className="text-un1t-bg font-semibold ml-1.5">{b.requestLabel}</Text>
      </Pressable>
    </View>
  )
}
