import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './App.css';
import { initialize as initAdMob, showBanner, showRewardedInterstitial, isAdFree, isFounderMode } from './admob.js';

let lastPauseTime = 0;

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

  // Initialize AdMob and show banner (skip in founder mode)
  await initAdMob();
  if (!isFounderMode()) await showBanner();

  // Listen for app state changes — show rewarded interstitial on resume after 10+ min
  try {
    const { App: CapApp } = await import('@capacitor/app');
    CapApp.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) {
        lastPauseTime = Date.now();
      } else if (lastPauseTime > 0) {
        const awayMinutes = (Date.now() - lastPauseTime) / 60000;
        if (awayMinutes >= 10 && !isAdFree() && !isFounderMode()) {
          await showRewardedInterstitial();
        }
        // Re-show banner on resume if not ad-free and not founder
        if (!isAdFree() && !isFounderMode()) {
          await showBanner();
        }
      }
    });
  } catch {
    // Web mode — no app state listener
  }
}

bootstrap();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
