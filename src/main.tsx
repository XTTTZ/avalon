import { createRoot } from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa/register';
import './styles.css';
import './theme.css';
import './pwa/pwa.css';

registerPwa();

// A single app mount avoids duplicate authentication and recovery work in development.
createRoot(document.getElementById('root')!).render(<App />);
