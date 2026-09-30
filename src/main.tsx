import React from 'react';
import ReactDOM from 'react-dom/client';
import './shell/tokens.css';
import { prefetchInitialScreen, Root } from './Root';
import { applyStoredTheme } from './brand';
import { capturePendingJoin } from './rooms/pendingJoin';
import './styles.css';

// A join code (/r/<slug>#<code>) leaves the address bar before anything renders (ROOMS_UX.md).
capturePendingJoin();
applyStoredTheme();
prefetchInitialScreen();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
