// AdMob Service - BullionLive
// Uses Capacitor Community AdMob plugin with test IDs

const TEST_IDS = {
  banner: {
    android: 'ca-app-pub-3940256099942544/6300978111',
    ios: 'ca-app-pub-3940256099942544/2934735716',
  },
  interstitial: {
    android: 'ca-app-pub-3940256099942544/1033173712',
    ios: 'ca-app-pub-3940256099942544/4411468910',
  },
};

let admobInitialized = false;
let interstitialReady = false;

export async function initialize() {
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.initialize({
      requestTrackingAuthorization: true,
      testingDevices: ['EMULATOR'],
      initializeForTesting: true,
    });
    admobInitialized = true;
    console.log('[AdMob] Initialized');
    // Pre-load first interstitial
    await prepareInterstitial();
  } catch (e) {
    console.log('[AdMob] Not available in web mode:', e.message);
  }
}

async function prepareInterstitial() {
  if (!admobInitialized) return;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.prepareInterstitial({
      adId: TEST_IDS.interstitial.android,
      isTesting: true,
    });
    interstitialReady = true;
  } catch (e) {
    console.log('[AdMob] prepareInterstitial error:', e.message);
  }
}

export async function showInterstitial() {
  if (!admobInitialized) return;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    if (interstitialReady) {
      interstitialReady = false;
      await AdMob.showInterstitial();
      // Pre-load next one
      await prepareInterstitial();
    }
  } catch (e) {
    console.log('[AdMob] showInterstitial error:', e.message);
    interstitialReady = false;
    await prepareInterstitial();
  }
}

export async function showBanner() {
  if (!admobInitialized) return;
  try {
    const { AdMob, BannerAdSize, BannerAdPosition } = await import('@capacitor-community/admob');
    await AdMob.showBanner({
      adId: TEST_IDS.banner.android,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: 0,
      isTesting: true,
    });
    console.log('[AdMob] Banner shown');
  } catch (e) {
    console.log('[AdMob] showBanner error:', e.message);
  }
}

export async function hideBanner() {
  if (!admobInitialized) return;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.hideBanner();
  } catch (e) {
    // ignore
  }
}
