// MOB-UI.3 — SplitView (master-detail) primitive (RN). Tablet: master
// list (fixed MASTER_PANE_WIDTH_PT) beside a flexing detail pane.
// Phone: a single pane — detail when `hasSelection`, else the master
// list (parent controls selection + a back action). Decision logic is
// unit-tested in ../../lib/ui-styles.js.
import { View } from 'react-native'
import { useIsTablet } from '../../lib/use-is-tablet'
import { MASTER_PANE_WIDTH_PT } from '../../lib/tablet-breakpoint.js'
import { splitShowsBothPanes, splitPhonePane, masterPaneClasses } from '../../lib/ui-styles.js'

/**
 * @param {object} props
 * @param {React.ReactNode} props.master       the list pane
 * @param {React.ReactNode} props.detail       the detail pane
 * @param {boolean} props.hasSelection         phone: show detail when true
 */
export default function SplitView({ master, detail, hasSelection = false }) {
  const isTablet = useIsTablet()

  if (splitShowsBothPanes(isTablet)) {
    return (
      <View className="flex-1 flex-row">
        <View className={masterPaneClasses()} style={{ width: MASTER_PANE_WIDTH_PT }}>{master}</View>
        <View className="flex-1">{detail}</View>
      </View>
    )
  }

  return <View className="flex-1">{splitPhonePane(hasSelection) === 'detail' ? detail : master}</View>
}
