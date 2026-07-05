// TV-MOBILE.C — mobile template canvas. Renders the base image with the
// text zones laid over it, mirroring the web renderer
// (src/components/TemplateCanvas.jsx) pixel-for-pixel:
//
//   - The outer box holds a fixed 16:9 aspect ratio (matches the TVs),
//     but the image itself renders with resizeMode="contain" — so the
//     box letterboxes whenever the base image isn't 16:9.
//   - Zone geometry (x/y/width/height, all % of the base image) and
//     fontSize (% of image height) are positioned against that
//     *contained* image rectangle, not the outer box — otherwise zones
//     drift off the image whenever the aspect ratios differ.
//
// TV-MOBILE.D — when a `values` prop is supplied (the push modal's
// per-zone overrides keyed by zone id), every zone is resolved through
// shared/tv-template's resolveZone() before rendering, so a push
// preview merges template defaults + operator overrides exactly like
// the live cast page. `values` is optional and omitted entirely by the
// template-edit screen, which still passes raw zones and relies on
// zone.defaultText/label as its preview text + on drag/resize editing —
// that editable path is untouched by the values/resolve logic below.
//
// TV-MOBILE.E — auto-fit: the operator's stored fontSize is the MAXIMUM
// size; RN's adjustsFontSizeToFit shrinks text that would otherwise
// overflow the zone box. Android only engages that behaviour when
// numberOfLines is set, so we derive a line-count bound from the zone's
// pixel height vs the font's line height.

import { useRef, useState, useEffect } from 'react'
import { View, Text, Image, PanResponder } from 'react-native'
import { resolveZone, textSegments, FLEX_V, FLEX_H } from '../../shared/tv-template'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// RN's flex values line up with the web FLEX_V/FLEX_H maps 1:1
// ('flex-start'/'center'/'flex-end'), so we reuse them directly.

export default function TvTemplateCanvas({
  imageUri, zones, values, selectedId, onSelect, onZoneChange, editable = true,
}) {
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [nat, setNat] = useState({ w: 0, h: 0 })

  // Natural size of the base image, fetched whenever the uri changes.
  // Image.getSize is the reliable cross-platform path (works for both
  // remote URLs and cached local files); an onLoad-only approach can
  // race a fast cache-hit render on some RN versions.
  useEffect(() => {
    if (!imageUri) { setNat({ w: 0, h: 0 }); return }
    let cancelled = false
    Image.getSize(
      imageUri,
      (w, h) => { if (!cancelled) setNat({ w, h }) },
      () => { if (!cancelled) setNat({ w: 0, h: 0 }) },
    )
    return () => { cancelled = true }
  }, [imageUri])

  // object-fit: contain rectangle for the base image inside the box —
  // identical math to web TemplateCanvas. With no base image yet (a
  // brand-new template in the editor) the whole box is the frame, so
  // zones stay visible and draggable before the image is picked.
  let frame = null
  if (box.w > 0 && box.h > 0 && nat.w > 0 && nat.h > 0) {
    const scale = Math.min(box.w / nat.w, box.h / nat.h)
    const w = nat.w * scale
    const h = nat.h * scale
    frame = { w, h, left: (box.w - w) / 2, top: (box.h - h) / 2 }
  } else if (!imageUri && box.w > 0 && box.h > 0) {
    frame = { w: box.w, h: box.h, left: 0, top: 0 }
  }

  return (
    <View
      className="w-full rounded-xl overflow-hidden bg-black border border-un1t-border"
      style={{ aspectRatio: 16 / 9 }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout
        if (width && height) setBox({ w: width, h: height })
      }}
    >
      {imageUri ? (
        <Image
          source={{ uri: imageUri }}
          resizeMode="contain"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
        />
      ) : (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
          <Text className="text-xs text-white/50">No base image yet</Text>
        </View>
      )}
      {frame && (zones || []).map((z) => (
        <ZoneBox
          key={z.id}
          zone={z}
          // Resolve template default + per-push override into a
          // render-ready style object. When `values` is absent (the
          // template-edit screen), resolveZone(z, undefined) still
          // merges cleanly against the zone's own defaults, and
          // resolvedText below falls back to label in editable mode.
          resolved={resolveZone(z, values?.[z.id])}
          frame={frame}
          editable={editable}
          selected={z.id === selectedId}
          onSelect={() => onSelect?.(z.id)}
          onChange={(patch) => onZoneChange?.(z.id, patch)}
        />
      ))}
    </View>
  )
}

function ZoneBox({ zone, resolved, frame, selected, editable, onSelect, onChange }) {
  // Latest values for the PanResponder closures (created once).
  const latest = useRef({})
  latest.current = { zone, frame, editable, onSelect, onChange }
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
        const { w, h } = latest.current.frame
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
        const { w, h } = latest.current.frame
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

  // Geometry + font size resolved against the contained-image rect —
  // mirrors web Zone() exactly (frame.left + x% * frame.w, etc).
  const left = frame.left + (resolved.x / 100) * frame.w
  const top = frame.top + (resolved.y / 100) * frame.h
  const w = (resolved.width / 100) * frame.w
  const h = (resolved.height / 100) * frame.h
  const fontPx = Math.max(1, (resolved.fontSize / 100) * frame.h)
  const lineHeightPx = fontPx * resolved.lineHeight

  // TV-MOBILE.E — numberOfLines bound so adjustsFontSizeToFit actually
  // engages on Android. A tiny zone still gets at least 1 line.
  const maxLines = Math.max(1, Math.floor(h / lineHeightPx))

  // In editable mode (template-edit screen) fall back to the zone's
  // label as placeholder preview text when there's no text at all —
  // resolveZone already folds defaultText into resolved.text, so this
  // only kicks in when defaultText is also empty.
  const resolvedText = resolved.text || (editable ? zone.label : '') || ''

  return (
    <View
      {...(editable ? movePan.panHandlers : {})}
      style={{
        position: 'absolute',
        left, top, width: w, height: h,
        alignItems: FLEX_H[resolved.align] || 'center',
        justifyContent: FLEX_V[resolved.vAlign] || 'center',
        overflow: 'hidden',
        borderWidth: selected ? 1.5 : editable ? 1 : 0,
        borderColor: selected ? '#0EA5E9' : 'rgba(255,255,255,0.35)',
        borderStyle: selected ? 'solid' : 'dashed',
      }}
    >
      <Text
        adjustsFontSizeToFit
        minimumFontScale={0.2}
        numberOfLines={maxLines}
        style={{
          width: '100%',
          fontSize: fontPx,
          fontWeight: String(resolved.fontWeight),
          textAlign: resolved.align,
          lineHeight: lineHeightPx,
          textTransform: resolved.uppercase ? 'uppercase' : 'none',
        }}
      >
        {/* Per-character colour runs (TV-TEMPLATE.5) — same split as
            web's textSegments, nested <Text> per run. */}
        {textSegments(resolvedText, resolved.colorRuns, resolved.color).map((seg, i) => (
          <Text key={i} style={{ color: seg.color }}>{seg.text}</Text>
        ))}
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
