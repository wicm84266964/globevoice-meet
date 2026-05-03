import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

window.addEventListener('error', (event) => {
  window.electronAPI?.log?.(`[renderer error] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason)
  window.electronAPI?.log?.(`[renderer rejection] ${reason}`)
})

window.electronAPI?.log?.(`[renderer] bootstrap root=${Boolean(document.getElementById('root'))} electronAPI=${Boolean(window.electronAPI)}`)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

window.electronAPI?.log?.('[renderer] react render submitted')
