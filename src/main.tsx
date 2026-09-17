import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// A single app mount avoids re-running OAuth exchange during development strict effects.
createRoot(document.getElementById('root')!).render(<App />);
