interface ToolbarProps {
  onRefresh: () => void
  onOpenCreateTaskWindow: () => void
}

function Toolbar({ onRefresh, onOpenCreateTaskWindow }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-title">AgentHome - 任务管理</div>
      <div className="toolbar-actions">
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