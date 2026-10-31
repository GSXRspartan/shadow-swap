import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { registerValueCodecLoader } from './services/ootleWire.js';
import './styles/global.css';

// Ootle v0.48 serves engine values as base64 CBOR. The official decoder is loaded lazily,
// on the first read that needs it, so a pre-v0.48 network never downloads it.
registerValueCodecLoader(async () => (await import('./wasm/ootleWasmBor.browser.js')).loadOotleWasmBor());

const container = document.getElementById('root');
if (container === null) throw new Error('Root container #root is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
