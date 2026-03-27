import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './App.css';
import { initialize as initAdMob, showBanner } from './admob.js';

async function bootstrap() {
  // Hide splash screen (Capacitor native only)
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    // Web mode — no splash screen available
  }

  // Configure status bar (Capacitor native only)
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0a0a1a' });
  } catch {
    // Web mode
  }

  // Initialize AdMob and show banner
  await initAdMob();
  await showBanner();
}

bootstrap();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
