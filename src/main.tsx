import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// A single app mount avoids duplicate authentication and recovery work in development.
createRoot(document.getElementById('root')!).render(<App />);
