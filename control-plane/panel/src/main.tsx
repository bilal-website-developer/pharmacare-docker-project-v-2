import React from 'react';
import { createRoot } from 'react-dom/client';
import { ControlPanel } from './ControlPanel';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Control panel root element is missing');

createRoot(rootElement).render(
  <React.StrictMode>
    <ControlPanel />
  </React.StrictMode>,
);
