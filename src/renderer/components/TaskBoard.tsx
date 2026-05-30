import type { Task, Column } from '../../shared/types'
import TaskCard from './TaskCard'

const COLUMNS: Column[] = [
  { id: 'created', title: '新建任务（待启动）', color: '#6c757d' },
  { id: 'running', title: '运行中任务', color: '#0d6efd' },
  { id: 'completed', title: '完成任务', color: '#198754' },
  { id: 'interrupted', title: '中断的任务', color: '#dc3545' }
]

interface TaskBoardProps {
  tasks: Task[]
  onStatusChange: (id: string, status: Task['status']) => void
  selectedTaskId?: string
  onSelectTask: (id: string) => void
}

function TaskBoard({ tasks, onStatusChange, selectedTaskId, onSelectTask }: TaskBoardProps) {
  const getTasksByStatus = (status: Task['status']) => {
    if (status === 'running') {
      return tasks.filter(t => t.status === 'running' || t.status === 'waiting_input')
    }
    return tasks.filter(t => t.status === status)
  }

  return (
    <div className="task-board">
      {COLUMNS.map(col => (
        <div key={col.id} className="column">
          <div className="column-header" style={{ borderColor: col.color }}>
            <span className="column-title">{col.title}</span>
            <span className="column-count">{getTasksByStatus(col.id).length}</span>
          </div>
          <div
            className="column-body"
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(e) => {
              e.preventDefault()
              const taskId = e.dataTransfer.getData('text/task-id')
              if (!taskId) return
              onStatusChange(taskId, col.id)
            }}
          >
            {getTasksByStatus(col.id).map(task => (
              <TaskCard
                key={task.id}
                task={task}
                onSelect={onSelectTask}
                selected={task.id === selectedTaskId}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default TaskBoard