import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bullionlive.app',
  appName: 'BS BullionX',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0a0a1a',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0a0a1a',
      androidSplashResourceName: 'splash',
      showSpinner: false,
      launchAutoHide: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a1a',
    },
    AdMob: {
      appId: {
        android: 'ca-app-pub-3940256099942544~3347511713',
        ios: 'ca-app-pub-3940256099942544~1458002511',
      },
    },
  },
};

export default config;
