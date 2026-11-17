import { createRoot } from 'react-dom/client';
import './styles.css';
import { RouterProvider } from './lib/router.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './ui.jsx';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <RouterProvider><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></RouterProvider>,
);
