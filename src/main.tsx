import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './styles/index.css'
import { App } from './App'
import { FeedbackProvider } from './components/ui/Feedback'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* HashRouter : fonctionne tel quel sur n'importe quel hébergement statique, hors ligne et dans Capacitor. */}
    <HashRouter>
      <FeedbackProvider>
        <App />
      </FeedbackProvider>
    </HashRouter>
  </StrictMode>,
)
