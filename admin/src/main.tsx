import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WebPlayer } from './player/WebPlayer';
import './styles.css';

// /player is the browser-based player (kiosk mode); everything else is the admin.
const isPlayer = window.location.pathname.replace(/\/+$/, '') === '/player';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isPlayer ? <WebPlayer /> : <App />}</StrictMode>,
);
