import { useState, useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import TaskBoard from './components/TaskBoard'
import Toolbar from './components/Toolbar'
import TaskInteractionPanel from './components/TaskInteractionPanel'
import type { Task } from '../shared/types'

function App() {
  const MIN_PANEL_WIDTH = 280
  const MAX_PANEL_WIDTH = 760
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [panelWidth, setPanelWidth] = useState(420)

  useEffect(() => {
    loadTasks()
    const timer = window.setInterval(loadTasks, 2000)
    return () => window.clearInterval(timer)
  }, [])

  const loadTasks = async () => {
    try {
      const loaded = await window.electronAPI.getTasks()
      setTasks(loaded)
    } catch (e) {
      console.error('Failed to load tasks:', e)
    }
  }

  useEffect(() => {
    if (!selectedTaskId && tasks.length > 0) {
      setSelectedTaskId(tasks[0].id)
      return
    }
    if (selectedTaskId && !tasks.some(task => task.id === selectedTaskId)) {
      setSelectedTaskId(tasks[0]?.id)
    }
  }, [tasks, selectedTaskId])

  const handleOpenCreateTaskWindow = async () => {
    try {
      await window.electronAPI.openTaskCreateWindow()
    } catch (e) {
      console.error('Failed to open task create window:', e)
    }
  }

  const handleStatusChange = async (id: string, status: Task['status']) => {
    try {
      await window.electronAPI.updateTaskStatus(id, status)
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status } : t))
    } catch (e) {
      console.error('Failed to update task:', e)
    }
  }

  const selectedTask = tasks.find(t => t.id === selectedTaskId)

  const handleResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (panelCollapsed) return
    event.preventDefault()

    const startX = event.clientX
    const startWidth = panelWidth
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX
      const nextWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + delta))
      setPanelWidth(nextWidth)
    }
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div className="app">
      <Toolbar onRefresh={loadTasks} onOpenCreateTaskWindow={handleOpenCreateTaskWindow} />
      <div className="main-content">
        <TaskBoard
          tasks={tasks}
          onStatusChange={handleStatusChange}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
        />
        {!panelCollapsed && (
          <div className="panel-resizer" onMouseDown={handleResizeStart} />
        )}
        <TaskInteractionPanel
          task={selectedTask}
          collapsed={panelCollapsed}
          width={panelWidth}
          onToggle={() => setPanelCollapsed(prev => !prev)}
        />
      </div>
    </div>
  )
}

export default App