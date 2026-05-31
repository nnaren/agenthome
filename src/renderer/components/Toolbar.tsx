import { useState } from 'react'
import { applyTheme, getStoredTheme, THEME_OPTIONS, type ThemePreference } from '../theme'

interface ToolbarProps {
  onRefresh: () => void
  onOpenCreateTaskWindow: () => void
}

function Toolbar({ onRefresh, onOpenCreateTaskWindow }: ToolbarProps) {
  const [theme, setTheme] = useState<ThemePreference>(() => getStoredTheme())

  const handleThemeChange = (next: ThemePreference) => {
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div className="toolbar">
      <div className="toolbar-title">AgentHome - 任务管理</div>
      <div className="toolbar-actions">
        <div className="theme-switcher" role="group" aria-label="主题">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`theme-switcher-btn${theme === option.value ? ' is-active' : ''}`}
              onClick={() => handleThemeChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button className="btn-primary" onClick={onOpenCreateTaskWindow}>
          + 新建任务
        </button>
        <button className="btn-secondary" onClick={onRefresh}>
          刷新
        </button>
      </div>
    </div>
  )
}

export default Toolbar
