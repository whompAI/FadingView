# FadingView Handoff

## Overview
Streamlit-based TradingView-style dashboard with a Whomp-inspired skin. The UI is rendered via `components.html` and uses TradingView Lightweight Charts. Watchlist clicks update the chart instantly in the iframe; timeframe/EXT toggles reload the Streamlit app via query params.

## How to run locally
1) `python3 -m venv .venv && source .venv/bin/activate`
2) `pip install -r requirements.txt`
3) `streamlit run app.py`

App URL: http://localhost:8501

## Controls and UX
- Watchlist: click to switch symbol, drag handle to reorder (stored in `localStorage`).
- Header: timeframe buttons + EXT toggle (sets query params `tf` and `ext`).
- Indicators: SMA20/EMA50 toggles (stored in `localStorage`).
- Right rail: quote card docked at bottom of watchlist column.

## Data flow
- Source: `yfinance` OHLCV.
- EXT toggle: uses `prepost=True` for intraday timeframes.
- Fallback: if intraday data is empty, the symbol falls back to daily (1D) data.
- Missing symbols: shown as "NO DATA" in watchlist and a warning banner appears.

Query params:
- `sel`: selected symbol
- `tf`: timeframe (1m, 5m, 15m, 1h, 4h, 1D, 1W)
- `ext`: extended hours flag (1/0, true/false)

## Key files
- `app.py`: main Streamlit app, HTML/CSS/JS template, data fetch, and state.
- `requirements.txt`: Python deps.
- `tradingview_exact.html`: legacy static replica (not used by the Streamlit app).

## Known limitations
- No live streaming (polls via yfinance on rerun only).
- Some symbols do not provide intraday/pre/post data in yfinance.
- Header/controls are in the embedded HTML, not native Streamlit widgets.

## Suggested next steps
- Add RSI/MACD/VWAP and volume bars.
- Add watchlist search + add/remove tickers.
- Add news/earnings metadata to the right-rail card.
- Consider a live data source + websocket for real-time ticks.
