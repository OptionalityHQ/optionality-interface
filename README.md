# Optionality Interface (`optionality-interface`)

Web trading terminal, interactive positions chart, NEAR wallet selector integration, and browser E2E verification suite for **Optionality**.

## Repository Structure

- **`api/src/positions-chart.ts`** — Interactive canvas chart with 2D draggable pending orders, break-even lines, custom expiry selection, and fractional/USDT sizing.
- **`api/src/chart-canvas.ts`, `chart-clock.ts`, `chart-navigation.ts`, `candles.ts`, `indicators.ts`** — Canvas rendering primitives, smooth interpolation, zoom/pan navigation, and technical indicators (EMA, SMA, Bollinger Bands, VWAP, RSI).
- **`api/src/wallet.ts`** — Official NEAR Wallet Selector integration (Meteor Wallet, MyNearWallet, and isolated sandbox accounts).
- **`sim/demo-template.html` & `sim/build-demo.mjs`** — Unified application shell (Board, Chart, Positions, Strategies, Leaderboard, Copy Trading) and static bundle compiler.
- **`demo/`** — Compiled static web assets (`index.html`, `landing.html`, `docs.html`, `images/`, `media/`).
- **`sim/e2e.mts`, `sim/suite.mts`, `sim/journey.mjs`** — End-to-end browser verification suites.

## Build & Test

```bash
npm test
npm run build
```
