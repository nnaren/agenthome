import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TaskCreateWindow from './components/TaskCreateWindow'
import './styles/index.css'

const isTaskCreateWindow = window.location.hash === '#/task-create'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isTaskCreateWindow ? <TaskCreateWindow /> : <App />}
  </React.StrictMode>
)