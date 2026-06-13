// TV-MOBILE.C — mobile template canvas. Renders the base image (16:9,
// matching the TV) with the text zones laid over it. When `editable`,
// each zone can be dragged to move and corner-dragged to resize, and
// tapped to select — the RN counterpart of the web TemplateCanvas.
//
// Geometry is the same model as web: x / y / width / height are % of the
// base image; fontSize is % of image height. PanResponder handlers read
// the latest props/size from refs so they never go stale.

import { useRef, useState } from 'react'
import { View, Text, Image, PanResponder } from 'react-native'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export default function TvTemplateCanvas({ imageUri, zones, selectedId, onSelect, onZoneChange, editable = true }) {
  const [size, setSize] = useState({ w: 1, h: 1 })
  return (
    <View
      className="w-full rounded-xl overflow-hidden bg-black border border-un1t-border"
      style={{ aspectRatio: 16 / 9 }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout
        if (width && height) setSize({ w: width, h: height })
      }}
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }} />
      ) : (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
          <Text className="text-xs text-white/50">No base image yet</Text>
        </View>
      )}
      {(zones || []).map((z) => (
        <ZoneBox
          key={z.id}
          zone={z}
          size={size}
          selected={z.id === selectedId}
          editable={editable}
          onSelect={() => onSelect?.(z.id)}
          onChange={(patch) => onZoneChange?.(z.id, patch)}
        />
      ))}
    </View>
  )
}

function ZoneBox({ zone, size, selected, editable, onSelect, onChange }) {
  // Latest values for the PanResponder closures (created once).
  const latest = useRef({})
  latest.current = { zone, size, editable, onSelect, onChange }
  const orig = useRef(null)

  const movePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.editable,
      onMoveShouldSetPanResponder: (_, g) => latest.current.editable && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
      onPanResponderGrant: () => {
        const z = latest.current.zone
        latest.current.onSelect?.()
        orig.current = { x: z.x, y: z.y, width: z.width, height: z.height }
      },
      onPanResponderMove: (_, g) => {
        const o = orig.current
        const { w, h } = latest.current.size
        if (!o || !w || !h) return
        const dx = (g.dx / w) * 100
        const dy = (g.dy / h) * 100
        latest.current.onChange?.({
          x: clamp(o.x + dx, 0, 100 - o.width),
          y: clamp(o.y + dy, 0, 100 - o.height),
        })
      },
    }),
  ).current

  const resizePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.editable,
      onMoveShouldSetPanResponder: () => latest.current.editable,
      onPanResponderGrant: () => {
        const z = latest.current.zone
        latest.current.onSelect?.()
        orig.current = { x: z.x, y: z.y, width: z.width, height: z.height }
      },
      onPanResponderMove: (_, g) => {
        const o = orig.current
        const { w, h } = latest.current.size
        if (!o || !w || !h) return
        const dx = (g.dx / w) * 100
        const dy = (g.dy / h) * 100
        latest.current.onChange?.({
          width: clamp(o.width + dx, 5, 100 - o.x),
          height: clamp(o.height + dy, 4, 100 - o.y),
        })
      },
    }),
  ).current

  const fontPx = Math.max(8, ((zone.fontSize ?? 8) / 100) * (size.h || 1))
  const justify = zone.vAlign === 'top' ? 'flex-start' : zone.vAlign === 'bottom' ? 'flex-end' : 'center'
  const text = (zone.text ?? zone.defaultText ?? '') || (editable ? zone.label : '')

  return (
    <View
      {...(editable ? movePan.panHandlers : {})}
      style={{
        position: 'absolute',
        left: `${zone.x}%`,
        top: `${zone.y}%`,
        width: `${zone.width}%`,
        height: `${zone.height}%`,
        justifyContent: justify,
        paddingHorizontal: 2,
        borderWidth: selected ? 1.5 : editable ? 1 : 0,
        borderColor: selected ? '#0EA5E9' : 'rgba(255,255,255,0.35)',
        borderStyle: selected ? 'solid' : 'dashed',
      }}
    >
      <Text
        numberOfLines={6}
        style={{
          color: zone.color || '#FFFFFF',
          fontSize: fontPx,
          fontWeight: String(zone.fontWeight ?? 700),
          textAlign: zone.align || 'center',
          lineHeight: fontPx * (zone.lineHeight ?? 1.15),
          textTransform: zone.uppercase ? 'uppercase' : 'none',
        }}
      >
        {text}
      </Text>

      {editable && selected && (
        <View
          {...resizePan.panHandlers}
          style={{
            position: 'absolute', right: -10, bottom: -10, width: 22, height: 22,
            borderRadius: 11, backgroundColor: '#0EA5E9',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <View style={{ width: 8, height: 8, borderRightWidth: 2, borderBottomWidth: 2, borderColor: '#FFFFFF' }} />
        </View>
      )}
    </View>
  )
}
