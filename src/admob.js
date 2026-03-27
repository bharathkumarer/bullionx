// AdMob Service - BullionLive
// Full ad integration: Banner, Interstitial, Rewarded, Rewarded Interstitial
// Strategy: monetize well but keep user experience smooth

const TEST_IDS = {
  banner: {
    android: 'ca-app-pub-3940256099942544/6300978111',
    ios: 'ca-app-pub-3940256099942544/2934735716',
  },
  interstitial: {
    android: 'ca-app-pub-3940256099942544/1033173712',
    ios: 'ca-app-pub-3940256099942544/4411468910',
  },
  rewarded: {
    android: 'ca-app-pub-3940256099942544/5224354917',
    ios: 'ca-app-pub-3940256099942544/1712485313',
  },
  rewardedInterstitial: {
    android: 'ca-app-pub-3940256099942544/5354046379',
    ios: 'ca-app-pub-3940256099942544/6978759866',
  },
};

let admobInitialized = false;
let interstitialReady = false;
let rewardedReady = false;
let rewardedInterstitialReady = false;

// Track ad-free period (rewarded by watching an ad)
let adFreeUntil = 0;

export function isFounderMode() {
  try { return localStorage.getItem('bsx_founder') === '1'; }
  catch { return false; }
}

export function isAdFree() {
  return isFounderMode() || Date.now() < adFreeUntil;
}

export function setAdFree(durationMs) {
  adFreeUntil = Date.now() + durationMs;
  try {
    localStorage.setItem('adFreeUntil', String(adFreeUntil));
  } catch { /* ignore */ }
}

function restoreAdFree() {
  try {
    const saved = localStorage.getItem('adFreeUntil');
    if (saved) adFreeUntil = parseInt(saved, 10) || 0;
  } catch { /* ignore */ }
}

// ─── Initialize ───────────────────────────────────────────────────────────────

export async function initialize() {
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.initialize({
      requestTrackingAuthorization: true,
      testingDevices: ['EMULATOR'],
      initializeForTesting: true,
    });
    admobInitialized = true;
    restoreAdFree();
    console.log('[AdMob] Initialized');

    // Pre-load ads in parallel
    await Promise.allSettled([
      prepareInterstitial(),
      prepareRewarded(),
      prepareRewardedInterstitial(),
    ]);
  } catch (e) {
    console.log('[AdMob] Not available in web mode:', e.message);
  }
}

// ─── Banner Ad ────────────────────────────────────────────────────────────────
// Persistent adaptive banner at bottom — minimal intrusion, steady revenue

export async function showBanner() {
  if (!admobInitialized || isAdFree()) return;
  try {
    const { AdMob, BannerAdSize, BannerAdPosition } = await import('@capacitor-community/admob');
    await AdMob.showBanner({
      adId: TEST_IDS.banner.android,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: 56, // above the bottom nav bar
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
  } catch { /* ignore */ }
}

// ─── Interstitial Ad ─────────────────────────────────────────────────────────
// Full-screen ad on tab switches — every 5th switch, skipped during ad-free

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
  if (!admobInitialized || isAdFree()) return false;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    if (interstitialReady) {
      interstitialReady = false;
      await AdMob.showInterstitial();
      await prepareInterstitial();
      return true;
    }
  } catch (e) {
    console.log('[AdMob] showInterstitial error:', e.message);
    interstitialReady = false;
    await prepareInterstitial();
  }
  return false;
}

// ─── Rewarded Ad ──────────────────────────────────────────────────────────────
// User opts in: "Watch ad → 30 min ad-free". High eCPM, good user sentiment.

async function prepareRewarded() {
  if (!admobInitialized) return;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.prepareRewardVideoAd({
      adId: TEST_IDS.rewarded.android,
      isTesting: true,
    });
    rewardedReady = true;
  } catch (e) {
    console.log('[AdMob] prepareRewarded error:', e.message);
  }
}

export function isRewardedReady() {
  return rewardedReady;
}

/**
 * Show a rewarded ad. Returns true if user watched to completion.
 * Grants 30 minutes ad-free on success.
 */
export async function showRewarded() {
  if (!admobInitialized || !rewardedReady) return false;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    rewardedReady = false;
    const result = await AdMob.showRewardVideoAd();
    // Grant 30 min ad-free
    setAdFree(30 * 60 * 1000);
    hideBanner(); // immediately hide banner
    await prepareRewarded();
    console.log('[AdMob] Reward granted:', result);
    return true;
  } catch (e) {
    console.log('[AdMob] showRewarded error:', e.message);
    rewardedReady = false;
    await prepareRewarded();
    return false;
  }
}

// ─── Rewarded Interstitial ───────────────────────────────────────────────────
// Shown on app resume after inactivity — user gets reward for watching

async function prepareRewardedInterstitial() {
  if (!admobInitialized) return;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    await AdMob.prepareRewardInterstitialAd({
      adId: TEST_IDS.rewardedInterstitial.android,
      isTesting: true,
    });
    rewardedInterstitialReady = true;
  } catch (e) {
    console.log('[AdMob] prepareRewardedInterstitial error:', e.message);
  }
}

/**
 * Show rewarded interstitial (app resume after 10+ min away).
 * User gets 15 min ad-free as a thank-you.
 */
export async function showRewardedInterstitial() {
  if (!admobInitialized || isAdFree() || !rewardedInterstitialReady) return false;
  try {
    const { AdMob } = await import('@capacitor-community/admob');
    rewardedInterstitialReady = false;
    await AdMob.showRewardInterstitialAd();
    // Grant 15 min ad-free for watching
    setAdFree(15 * 60 * 1000);
    hideBanner();
    await prepareRewardedInterstitial();
    return true;
  } catch (e) {
    console.log('[AdMob] showRewardedInterstitial error:', e.message);
    rewardedInterstitialReady = false;
    await prepareRewardedInterstitial();
    return false;
  }
}

// ─── Re-show banner when ad-free expires ──────────────────────────────────────

export function startAdFreeWatcher() {
  const interval = setInterval(() => {
    if (!isAdFree() && admobInitialized) {
      showBanner();
      clearInterval(interval);
    }
  }, 60000); // check every minute
  return interval;
}
