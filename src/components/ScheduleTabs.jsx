'use client'

import { useState } from 'react'
import { CalendarClock, CheckCircle, BarChart3 } from 'lucide-react'
import ScheduleCalendar from './ScheduleCalendar'
import ScheduleApprovals from './ScheduleApprovals'
import ScheduleReporting from './ScheduleReporting'

const canManage = (role) => ['owner', 'manager', 'head_coach'].includes(role)

export default function ScheduleTabs({ user }) {
  const [activeTab, setActiveTab] = useState('schedule')
  const isManager = canManage(user.role)

  const tabs = [
    { key: 'schedule', label: 'Schedule', icon: CalendarClock, show: true },
    { key: 'approvals', label: 'Approvals', icon: CheckCircle, show: isManager },
    { key: 'reporting', label: 'Reporting', icon: BarChart3, show: isManager },
  ].filter(t => t.show)

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 border-b border-un1t-gray">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-white text-white'
                : 'border-transparent text-un1t-light hover:text-white'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'schedule' && <ScheduleCalendar user={user} />}
      {activeTab === 'approvals' && isManager && <ScheduleApprovals user={user} />}
      {activeTab === 'reporting' && isManager && <ScheduleReporting user={user} />}
    </div>
  )
}
