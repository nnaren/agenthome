import type { Task } from '../../shared/types'

const STATUS_LABELS: Record<Task['status'], string> = {
  created: '创建',
  running: '运行中',
  waiting_input: '等待输入',
  completed: '完成',
  interrupted: '中断'
}

const NEXT_STATUS: Partial<Record<Task['status'], Task['status']>> = {
  created: 'running',
  running: 'completed',
  waiting_input: 'running',
  interrupted: 'running'
}

interface TaskCardProps {
  task: Task
  onStatusChange: (id: string, status: Task['status']) => void
  onSelect: (id: string) => void
  selected: boolean
}

function TaskCard({ task, onStatusChange, onSelect, selected }: TaskCardProps) {
  const nextStatus = NEXT_STATUS[task.status]

  return (
    <div className={`task-card ${selected ? 'task-card-selected' : ''}`} onClick={() => onSelect(task.id)}>
      <div className="task-name">{task.name || '(未命名任务)'}</div>
      {task.description && <div className="task-desc">{task.description}</div>}
      <div className="task-meta">Agent: {task.agent}</div>
      <div className="task-meta">路径: {task.workPath}</div>
      <div className="task-meta">命令: {task.command}</div>
      <div className="task-footer">
        <span className="task-status">{STATUS_LABELS[task.status]}</span>
        {nextStatus && (
          <button
            className="btn-next"
            onClick={(e) => {
              e.stopPropagation()
              onStatusChange(task.id, nextStatus)
            }}
          >
            → {STATUS_LABELS[nextStatus]}
          </button>
        )}
      </div>
    </div>
  )
}

export default TaskCard