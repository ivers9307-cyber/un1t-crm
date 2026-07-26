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
// TV-MOBILE.G — auto-fit: the operator's stored fontSize is the MAXIMUM
// size; a measured shrink loop (mirroring web useFitText) resizes text
// that would otherwise overflow the zone box. The old TV-MOBILE.E
// approach (adjustsFontSizeToFit + a numberOfLines bound derived from
// the zone height AT THE MAX SIZE) truncated any text with more hard
// newlines than fit at full size — a 13-line workout board showed only
// its first lines — and a fixed pixel lineHeight stopped RN's shrinker
// reclaiming vertical space at all. Instead we seed from seedFitPx (so
// every hard newline gets a line slot immediately, no giant first
// paint) and converge on onTextLayout measurements via the shared
// fitStepFromLines/nextFitPx step, identically to the web renderer.

import { useRef, useState, useEffect } from 'react'
import { View, Text, Image, PanResponder } from 'react-native'
import {
  resolveZone, textSegments, seedFitPx, fitStepFromLines, MIN_FIT_PX, FLEX_V, FLEX_H,
} from 'shared/tv-template'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// TV-STYLE.2 — Poppins is the TV-template face (matches web
// tv-font.js). RN custom fonts are ONE family per weight — the
// numeric fontWeight style is ignored for them — so zone text maps
// its resolved weight to the nearest loaded Poppins family instead.
// Families are loaded non-blocking in app/_layout.jsx; until then RN
// falls back to the system font for an unknown family name.
function poppinsFamily(weight) {
  const w = Number(weight) || 400
  if (w <= 450) return 'Poppins_400Regular'
  if (w <= 650) return 'Poppins_600SemiBold'
  if (w <= 750) return 'Poppins_700Bold'
  return 'Poppins_800ExtraBold'
}

// Same cap as web TemplateCanvas — each shrink changes wrapping, which
// can call for another shrink; iterate but never spin forever.
const MAX_FIT_ITERATIONS = 6

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
  // resolved.fontSize is a MAXIMUM (TV-MOBILE.G) — the measure loop
  // below shrinks the rendered size to whatever actually fits the box.
  const maxFontPx = Math.max(1, (resolved.fontSize / 100) * frame.h)

  // In editable mode (template-edit screen) fall back to the zone's
  // label as placeholder preview text when there's no text at all —
  // resolveZone already folds defaultText into resolved.text, so this
  // only kicks in when defaultText is also empty.
  const resolvedText = resolved.text || (editable ? zone.label : '') || ''

  // TV-MOBILE.G — measured auto-fit. Start from the newline-aware seed
  // and shrink on each onTextLayout until the block fits the zone box
  // (same convergence step as web useFitText). Everything that changes
  // wrapping or measurement resets the loop.
  const minFontPx = Math.min(MIN_FIT_PX, maxFontPx)
  const seedPx = seedFitPx(resolvedText, h, resolved.lineHeight, maxFontPx)
  const [fitPx, setFitPx] = useState(seedPx)
  const fitIterations = useRef(0)
  const fitKey = [
    resolvedText, maxFontPx, w, h,
    resolved.lineHeight, resolved.fontWeight, resolved.uppercase,
    // TV-STYLE.4 — per-segment sizes/weights change wrapping, so a
    // run edit must re-measure from the seed like a text edit does.
    JSON.stringify(resolved.styleRuns),
    // NUL separator: unlike a space it can never appear in the text,
    // so distinct inputs can't collide into one key.
  ].join('\0')
  useEffect(() => {
    fitIterations.current = 0
    setFitPx(seedPx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey])

  const onTextLayout = (e) => {
    if (fitIterations.current >= MAX_FIT_ITERATIONS) return
    const { fits, nextPx } = fitStepFromLines(e.nativeEvent.lines, w, h, fitPx, minFontPx)
    if (fits || Math.abs(nextPx - fitPx) < 0.5) return
    fitIterations.current += 1
    setFitPx(nextPx)
  }

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
        onTextLayout={onTextLayout}
        style={{
          width: '100%',
          fontSize: fitPx,
          // TV-STYLE.2 — weight is carried by the family name, not
          // the fontWeight style (RN ignores fontWeight for
          // single-weight custom families like Poppins_*).
          fontFamily: poppinsFamily(resolved.fontWeight),
          textAlign: resolved.align,
          // Scales with the fitted size — a fixed max-size lineHeight
          // would keep full-height line boxes after the glyphs shrink.
          lineHeight: fitPx * resolved.lineHeight,
          textTransform: resolved.uppercase ? 'uppercase' : 'none',
        }}
      >
        {/* Per-character style runs (TV-STYLE.4) — same split as
            web's textSegments, nested <Text> per run. A segment's
            fontSize is the ratio of the two stored percentages × the
            fitted base px, so mixed sizes shrink proportionally with
            the fit loop (matching web's em rendering). */}
        {textSegments(resolvedText, resolved.styleRuns, resolved.color).map((seg, i) => {
          const segPx = seg.fontSize && resolved.fontSize
            ? (seg.fontSize / resolved.fontSize) * fitPx
            : fitPx
          return (
            <Text
              key={i}
              style={{
                color: seg.color,
                fontSize: segPx,
                // Per-segment line box, proportional to its own size.
                lineHeight: segPx * resolved.lineHeight,
                // Bold/regular override rides the family name too
                // (see poppinsFamily above); unset falls back to the
                // zone's resolved weight.
                fontFamily: poppinsFamily(
                  seg.bold === true ? 800 : seg.bold === false ? 400 : resolved.fontWeight,
                ),
                textDecorationLine: seg.underline ? 'underline' : undefined,
              }}
            >
              {seg.text}
            </Text>
          )
        })}
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
