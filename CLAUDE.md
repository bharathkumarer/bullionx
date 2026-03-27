# BullionLive (BS BullionX)

Live precious metals price tracker for Indian users. React 19 + Vite 8 + Capacitor 8 Android app.

## Quick Reference

- **App ID:** `com.bullionlive.app`
- **Stack:** React 19, Vite 8 (rolldown), Capacitor 8, plain CSS (no Tailwind)
- **Single-page app:** All UI lives in `src/App.jsx`, styles in `src/App.css`
- **Theme:** Dark premium (#0a0a1a background, #FFD700 gold accents), mobile-first 480px max-width

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

- **`src/App.jsx`** — Entire app: 7 tabs (Gold, Silver, Platinum, Forex, Cities, Calculator, Alerts), data fetching, state management. Single-file by design.
- **`src/App.css`** — All styles via CSS custom properties. No CSS framework.
- **`src/admob.js`** — AdMob integration (interstitial every 4th tab switch). Uses test ad IDs.
- **`src/main.jsx`** — Capacitor plugin init (SplashScreen, StatusBar) + AdMob init.
- **`capacitor.config.ts`** — Capacitor config (TypeScript).
- **`vite.config.js`** — Vite dev proxy (`/yahoo/*` → Yahoo Finance), `manualChunks` must be a function (not object) for rolldown.

## Data Sources & Pricing

- **Primary:** Yahoo Finance v8 chart API via CORS proxies (allorigins.win, corsproxy.io, codetabs)
- **Dev mode:** Vite proxy at `/yahoo/*` — no CORS proxy needed locally
- **Fallbacks:** gold-api.com (metals), api.frankfurter.dev (forex)
- **Conversion:** TROY_OZ = 31.1035g, prices are spot USD × USD/INR rate, no duty/GST markup

## Code Conventions

- JSX files use `.jsx` extension
- ESLint with react-hooks and react-refresh plugins
- `no-unused-vars` ignores uppercase/underscore-prefixed names
- Alerts and previous-close data persisted in `localStorage`
- City premiums are small multipliers over base price (e.g., Chennai 1.003×)

## Important Notes

- All 7 tabs are in one file (`App.jsx`) — this is intentional, do not split without being asked
- The app targets Indian users — INR is the primary currency, prices shown per 10g (gold), per kg (silver), etc.
- AdMob IDs in config are Google test IDs — do not replace with production IDs without being asked
