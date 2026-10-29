import { createRoot } from 'react-dom/client'
import { api } from '@trippy/core'
import App from './App.tsx'
import { applyKey, type OwnKeySettings } from './Screens.tsx'
import { load } from './store.ts'
import './styles.css'

api.base = import.meta.env.VITE_PROXY_URL ?? 'http://localhost:8787'
load<OwnKeySettings>('settings').then(applyKey).catch(() => {}) // a saved own key replaces our relay (Settings)

createRoot(document.getElementById('root')!).render(<App />)
