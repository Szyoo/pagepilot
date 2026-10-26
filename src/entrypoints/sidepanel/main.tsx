import { createRoot } from 'react-dom/client';
import '../../shared/style.css';
import './sidepanel.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
