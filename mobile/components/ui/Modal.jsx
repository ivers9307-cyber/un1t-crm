// MOB-UI.3 — Modal primitive (RN). Responsive: bottom-sheet on phone,
// centered dialog on tablet. Mirrors the web Modal props (open,
// onClose, title, footer, dismissable). Backdrop press closes when
// dismissable; layout logic is unit-tested in ../../lib/ui-styles.js.
import { Modal as RNModal, View, Text, Pressable } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { modalOverlayClasses, modalContainerClasses, modalPanelClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {()=>void} props.onClose
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.footer]  action row rendered under the body
 * @param {boolean} [props.dismissable]     default true; false disables backdrop close
 * @param {React.ReactNode} props.children
 */
export default function Modal({ open, onClose, title, footer, dismissable = true, children }) {
  const isTablet = useIsTablet()
  return (
    <RNModal visible={open} transparent animationType="fade" onRequestClose={() => dismissable && onClose?.()}>
      <Pressable className={`${modalOverlayClasses()} ${modalContainerClasses({ isTablet })}`} onPress={() => dismissable && onClose?.()}>
        <Pressable className={modalPanelClasses({ isTablet })} onPress={() => {}}>
          {title != null && <Text className="mb-3 text-lg font-semibold text-un1t-text">{title}</Text>}
          {children}
          {footer != null && <View className="mt-4 flex-row justify-end gap-2">{footer}</View>}
        </Pressable>
      </Pressable>
    </RNModal>
  )
}
