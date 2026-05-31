import { useEffect, useState } from 'react'
import type { AgentType } from '../../shared/types'

const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'claude-code', label: 'Claude code' },
  { value: 'flow-cli', label: 'Flow CLI' },
  { value: 'hermes-agent', label: 'Hermes Agent' }
]

function TaskCreateWindow() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [agent, setAgent] = useState<AgentType>('claude-code')
  const [workPath, setWorkPath] = useState('')

  useEffect(() => {
    window.electronAPI.getProjectPath()
      .then(setWorkPath)
      .catch(() => setWorkPath(''))
  }, [])

  const handleSubmit = async () => {
    if (!description.trim() || !workPath.trim()) return

    await window.electronAPI.createTask({
      name: name.trim(),
      description: description.trim(),
      agent,
      workPath: workPath.trim(),
      createdAt: Date.now()
    })
    window.close()
  }

  const handlePickPath = async () => {
    const selectedPath = await window.electronAPI.selectDirectory()
    if (selectedPath) setWorkPath(selectedPath)
  }

  return (
    <div className="task-create-window">
      <h2 className="task-create-window-title">创建任务</h2>
      <div className="task-form task-form-window">
        <input
          className="form-input"
          placeholder="任务描述（必填）"
          value={description}
          onChange={e => setDescription(e.target.value)}
          autoFocus
        />
        <input
          className="form-input"
          placeholder="任务名称（可选）"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <select className="form-input form-select-window" value={agent} onChange={e => setAgent(e.target.value as AgentType)}>
          {AGENT_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          className="form-input"
          placeholder="执行路径（必填）"
          value={workPath}
          onChange={e => setWorkPath(e.target.value)}
        />
        <button className="btn-secondary" onClick={handlePickPath}>本地选择路径</button>
        <div className="form-hint">创建后进入待启动列，可拖拽到运行中启动任务</div>
        <div className="task-form-actions">
          <button className="btn-secondary" onClick={() => window.close()}>取消</button>
          <button className="btn-primary" onClick={handleSubmit}>创建任务</button>
        </div>
      </div>
    </div>
  )
}

export default TaskCreateWindow
