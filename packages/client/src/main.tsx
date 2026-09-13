import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { registerServiceWorker } from './lib/register-sw';
import { useToastStore } from './stores/toast';
import './index.css';

const queryClient = new QueryClient();

// Service Workerの登録(設計07章7.6・#251)。
// 開発時(vite dev)はSWを生成していないので登録しない — HMRを妨げないため
if (import.meta.env.PROD) {
  registerServiceWorker((applyUpdate) => {
    useToastStore
      .getState()
      .show('info', '新しいバージョンがあります', { label: '再読み込み', onClick: applyUpdate });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
