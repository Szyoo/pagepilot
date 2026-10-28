// 最先加载：让 EventSource 默认带 cookie（claude-bridge 的对话订阅要用）
import './eventsource-credentials';
import { createRoot } from 'react-dom/client';
import '../../shared/style.css';
import './sidepanel.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
