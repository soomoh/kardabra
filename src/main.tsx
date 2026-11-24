import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { IS_DEMO } from './lib/sites';

// Offline and installable: the build emits /sw.js for the app, not the demo
// (vite.config.ts, `pwa()`). A failed registration only costs offline use.
if (import.meta.env.PROD && !IS_DEMO && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
