import type { Task } from '../../shared/types'

const STATUS_LABELS: Record<Task['status'], string> = {
  created: '待启动',
  running: '运行中',
  waiting_input: '等待输入',
  completed: '完成',
  interrupted: '中断'
}

interface TaskCardProps {
  task: Task
  onSelect: (id: string) => void
  selected: boolean
}

function TaskCard({ task, onSelect, selected }: TaskCardProps) {
  return (
    <div
      className={`task-card ${selected ? 'task-card-selected' : ''}`}
      onClick={() => onSelect(task.id)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <div className="task-name">{task.name || '(未命名任务)'}</div>
      {task.description && <div className="task-desc">{task.description}</div>}
      <div className="task-meta">Agent: {task.agent}</div>
      <div className="task-meta">路径: {task.workPath}</div>
      <div className="task-meta">命令: {task.command}</div>
      <div className="task-footer">
        <span className="task-status">{STATUS_LABELS[task.status]}</span>
      </div>
    </div>
  )
}

export default TaskCard