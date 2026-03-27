# BullionLive (BS BullionX)

Live precious metals price tracker for Indian users. React 19 + Vite 8 + Capacitor 8 Android app.
Monetization: AdMob ads only. No user accounts, no backend, no RBAC.

## Quick Reference

- **App ID:** `com.bullionlive.app`
- **Stack:** React 19, Vite 8 (rolldown), Capacitor 8, plain CSS (no Tailwind)
- **Single-page app:** All UI lives in `src/App.jsx`, styles in `src/App.css`
- **Theme:** Dark premium (#0a0a1a background, #FFD700 gold accents), mobile-first 480px max-width
- **Repo:** https://github.com/bharathkumarer/bullionx.git

## Commands

```bash
npm run dev        # Local dev server on :5173 (Vite proxy handles CORS)
npm run build      # Production build → dist/
npm run lint       # ESLint
npm run preview    # Preview production build
npx cap sync       # Sync web assets to Android project
npx cap open android  # Open in Android Studio
```

## Architecture

- **`src/App.jsx`** — Entire app: 8 tabs (Gold, Silver, Platinum, Charts, Forex, Cities, Calculator, Alerts), data fetching, state management. Single-file by design.
- **`src/App.css`** — All styles via CSS custom properties. No CSS framework.
- **`src/admob.js`** — Full AdMob integration with 4 ad types + founder mode + ad-free rewards.
- **`src/main.jsx`** — Capacitor plugin init (SplashScreen, StatusBar) + AdMob init + app resume ad logic.
- **`capacitor.config.ts`** — Capacitor config (TypeScript).
- **`vite.config.js`** — Vite dev proxy (`/yahoo/*` → Yahoo Finance), `manualChunks` must be a function (not object) for rolldown.
- **`android/`** — Capacitor Android project (com.bullionlive.app, min SDK 24, target SDK 36).

## AdMob Monetization

Four ad types implemented in `src/admob.js`:

| Ad Type | Trigger | Details |
|---|---|---|
| **Banner** | Persistent at bottom | Adaptive banner above nav bar, shown on launch |
| **Interstitial** | Every 5th tab switch | Full-screen, skipped during ad-free/founder mode |
| **Rewarded Video** | User taps ad strip | "Watch ad → 30 min ad-free", highest eCPM |
| **Rewarded Interstitial** | App resume after 10+ min | Grants 15 min ad-free as reward |

- **All ad IDs are Google test IDs** — do not replace with production IDs without being asked
- Ad-free time persisted in `localStorage` as `adFreeUntil`
- Banner auto-re-shows when ad-free expires

## Founder Mode

Long-press "BS BullionX" title for **10 seconds** to toggle. Disables ALL ads for the founder (testing/demos).
- Persisted in `localStorage` as `bsx_founder`
- Checked in admob.js (`isFounderMode()`), App.jsx, and main.jsx
- No visual indicator — secret gesture only the founder knows

## Data Sources & Pricing

- **Primary:** Yahoo Finance v8 chart API via CORS proxies (allorigins.win, corsproxy.io, codetabs)
- **Dev mode:** Vite proxy at `/yahoo/*` — no CORS proxy needed locally
- **Fallbacks:** gold-api.com (metals), api.frankfurter.dev (forex)
- **Conversion:** TROY_OZ = 31.1035g, prices include Indian import duty (5% BCD + 1% AIDC = 1.06×)

## Code Conventions

- JSX files use `.jsx` extension
- ESLint with react-hooks and react-refresh plugins
- `no-unused-vars` ignores uppercase/underscore-prefixed names
- Alerts, previous-close data, ad-free time, founder mode persisted in `localStorage`
- City premiums are small multipliers over base price (e.g., Chennai 1.003×)

## Important Notes

- All 8 tabs are in one file (`App.jsx`) — this is intentional, do not split without being asked
- The app targets Indian users — INR is the primary currency, prices shown per 10g (gold), per kg (silver), etc.
- No backend, no user accounts, no RBAC — pure client-side app monetized by ads only
- Android project needs Android Studio + JDK to build (not available on current machine)

## Publishing Checklist

- [x] Ad system implemented (4 ad types)
- [x] Founder mode (ad-free for testing)
- [x] Android project initialized
- [x] Code pushed to GitHub
- [ ] Replace test AdMob IDs with production IDs
- [ ] App icon & splash screen branding
- [ ] Generate signing keystore
- [ ] Build signed AAB
- [ ] Google Play Developer account ($25)
- [ ] 20-tester closed testing for 14 days
- [ ] Privacy policy page
- [ ] Play Store listing (screenshots, description, feature graphic)
- [ ] Home screen widget (planned for post-launch)
