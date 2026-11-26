import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { IN_SHELL } from './shell'
import './theme.css'

if (IN_SHELL) document.documentElement.dataset.shell = 'mac'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
