import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { followWindow, IN_SHELL, IN_TRAY } from './shell'
import { Tray } from './tray'
import './theme.css'

if (IN_SHELL) {
  document.documentElement.dataset.shell = 'mac'
  followWindow()
}
if (IN_TRAY) document.documentElement.dataset.panel = 'tray'

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode>{IN_TRAY ? <Tray /> : <App />}</StrictMode>)
