import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import './flavors/default.css';
import './flavors/glass.css';
import './icons.css';
import { applyFlavor, DEFAULT_FLAVOR } from './flavor.js';

// The UI flavor until the server's setting loads (see App.jsx)
applyFlavor(DEFAULT_FLAVOR);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
