import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './cardFaces.css';
import './handPresentation.css';
import './tableTools.css';
import './reactions.css';
import './tableLayout.css';
import './compactControls.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
