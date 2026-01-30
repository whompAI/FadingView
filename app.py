import streamlit as st
import streamlit.components.v1 as components
import yfinance as yf
import pandas as pd
import requests
import re
import hashlib
import json
import html
import threading
import time
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from datetime import datetime

st.set_page_config(layout="wide", page_title="FadingView", initial_sidebar_state="collapsed")

# ── Palette — Whomp Dark ─────────────────────────────────────────────────────
BG      = "#0b0f0d"
PANEL   = "#0f1714"
BORDER  = "#1b2a24"
ACCENT  = "#00d084"
UP      = "#00d084"
DOWN    = "#ff5a5f"
TXT     = "#e7f5ef"
DIM     = "#6a7a73"
BLUE    = "#3cc4ff"
FONT_PRIMARY = "'Space Grotesk','Inter','Helvetica Neue',sans-serif"
FONT_MONO    = "'IBM Plex Mono','SF Mono','Fira Code','Cascadia Code',monospace"
DEFAULT_WATCHLIST = ["NQ=F","ES=F","SPY","QQQ","BTC-USD","NVDA","GOOG",
                     "META","PLTR","INTC","AMD","MU","AMZN","AAPL","AVGO"]
WATCHLIST_FILE = Path(__file__).with_name("watchlist.json")
ALLOW_SERVER_WATCHLIST = os.environ.get("FV_ALLOW_SERVER_WATCHLIST") == "1"
DEBUG_UI = os.environ.get("FV_DEBUG", "0") == "1"

TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"]

# ── Handle query params (symbol/timeframe/extended) ──────────────────────────
def _parse_bool(val):
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "t", "yes", "y", "on")
    return bool(val)

def _qp_value(qp, key):
    if key not in qp:
        return ""
    val = qp.get(key)
    if isinstance(val, list):
        return val[0] if val else ""
    return val

def _norm_symbol(raw):
    if raw is None:
        return ""
    sym = str(raw).strip().upper()
    # Allow common ticker chars: letters, digits, '=', '-', '.', '^', '/'
    sym = re.sub(r"[^A-Z0-9=\-.\^/]", "", sym)
    return sym

def _normalize_watchlist(items):
    cleaned = []
    for item in items or []:
        sym = _norm_symbol(item)
        if sym and sym not in cleaned:
            cleaned.append(sym)
    return cleaned

def handle_component_event(event):
    """Handle events from frontend. Returns True if new data fetched."""
    if not event:
        return False

    event_type = event.get("type")
    symbol = event.get("symbol")

    if event_type == "request_data" and symbol:
        try:
            data = yf.download(symbol, period="1d", interval="5m", progress=False)
            if not data.empty:
                if "chart_data" not in st.session_state:
                    st.session_state.chart_data = {}
                st.session_state.chart_data[symbol] = data.reset_index().to_dict("records")
                return True
        except Exception as exc:
            st.session_state[f"error_{symbol}"] = str(exc)
            return True

    elif event_type == "update_watchlist":
        st.session_state.watchlist = event.get("watchlist", [])
        return False

    elif event_type == "select_symbol":
        st.session_state.selected_symbol = symbol
        return False

    return False

def load_watchlist():
    if not ALLOW_SERVER_WATCHLIST:
        return list(DEFAULT_WATCHLIST)
    try:
        if WATCHLIST_FILE.exists():
            data = json.loads(WATCHLIST_FILE.read_text())
            if isinstance(data, list) and data:
                cleaned = []
                for item in data:
                    sym = _norm_symbol(item)
                    if sym and sym not in cleaned:
                        cleaned.append(sym)
                if cleaned:
                    return cleaned
    except Exception:
        pass
    return list(DEFAULT_WATCHLIST)

def save_watchlist(wl):
    if not ALLOW_SERVER_WATCHLIST:
        return
    try:
        WATCHLIST_FILE.write_text(json.dumps(wl))
    except Exception:
        pass

# ── State ────────────────────────────────────────────────────────────────────
if "watchlist" not in st.session_state:
    st.session_state.watchlist = load_watchlist()
if "selected" not in st.session_state:
    st.session_state.selected = st.session_state.watchlist[0] if st.session_state.watchlist else ""
if "timeframe" not in st.session_state:
    st.session_state.timeframe = "15m"
if "extended" not in st.session_state:
    st.session_state.extended = False
if "_fv_ready" not in st.session_state:
    st.session_state._fv_ready = False
if "_fv_last_event" not in st.session_state:
    st.session_state._fv_last_event = None
if "_fv_last_event_ts" not in st.session_state:
    st.session_state._fv_last_event_ts = None

qp = st.query_params
requested_symbol = None
watchlist_message = ""
search_query = str(_qp_value(qp, "search")).strip()
if search_query:
    search_query = search_query[:64]
if "sel" in qp:
    _s = _qp_value(qp, "sel")
    requested_symbol = _s
    if _s in st.session_state.watchlist:
        st.session_state.selected = _s
if "tf" in qp:
    _tf = _qp_value(qp, "tf")
    if _tf in TIMEFRAMES:
        st.session_state.timeframe = _tf
if "ext" in qp:
    st.session_state.extended = _parse_bool(_qp_value(qp, "ext"))
if "add" in qp:
    raw_add = _norm_symbol(_qp_value(qp, "add"))
    if raw_add:
        wl = list(st.session_state.watchlist)
        if raw_add not in wl:
            wl.append(raw_add)
            st.session_state.watchlist = wl
            st.session_state.selected = raw_add
        else:
            st.session_state.selected = raw_add
    else:
        watchlist_message = "Invalid ticker symbol"
if "rm" in qp:
    raw_rm = _norm_symbol(_qp_value(qp, "rm"))
    if raw_rm and raw_rm in st.session_state.watchlist:
        wl = [t for t in st.session_state.watchlist if t != raw_rm]
        st.session_state.watchlist = wl
        if st.session_state.selected == raw_rm:
            st.session_state.selected = wl[0] if wl else ""


# ── Streamlit CSS — ultra-minimal control bar ─────────────────────────────────
st.markdown(f"""<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
* {{ border-radius:0!important }}
html,body,[data-testid="stAppViewContainer"],[data-testid="stApp"]
  {{background:
      radial-gradient(1200px 600px at 20% -10%, rgba(0, 208, 132, 0.08), transparent 60%),
      radial-gradient(900px 600px at 85% 0%, rgba(60, 196, 255, 0.06), transparent 55%),
      {BG} !important;color:{TXT};overflow:hidden;
    font-family:{FONT_PRIMARY}!important}}
[data-testid="stHeader"],[data-testid="stToolbar"],
[data-testid="stDecoration"],#MainMenu,footer,header {{display:none!important}}
.block-container{{padding:0!important;margin:0!important;max-width:100%!important}}
section.main{{padding:0!important;margin:0!important}}
[data-testid="stAppViewContainer"]{{padding-top:0!important;margin-top:0!important}}
[data-testid="stAppViewContainer"]>div{{padding-top:0!important;margin-top:0!important}}
section.main>div{{padding-top:0!important;margin-top:0!important}}
[data-testid="stIFrame"]{{
  position:fixed!important;
  top:0!important;left:0!important;right:0!important;bottom:0!important;
  width:100vw!important;height:100vh!important;
  margin:0!important;
}}
[data-testid="stIFrame"] iframe{{
  width:100%!important;height:100%!important;
  display:block!important;margin:0!important;
}}
div[data-testid="stVerticalBlock"]>div{{gap:0}}
section.main>.block-container>div:first-child{{margin-top:0!important}}
::-webkit-scrollbar{{width:3px}}
::-webkit-scrollbar-track{{background:{BG}}}
::-webkit-scrollbar-thumb{{background:{BORDER}}}
p,span,div,label,button,[data-testid="stMarkdownContainer"]
  {{font-family:{FONT_PRIMARY}!important}}
/* thin control bar */
.ctrl-strip {{padding:2px 0!important;border-bottom:1px solid {BORDER}}}
[data-testid="stForm"]{{border:none!important;padding:0!important;margin:0!important}}
[data-testid="stHorizontalBlock"]{{gap:.4rem!important;align-items:center!important}}
input{{background:{PANEL}!important;color:{ACCENT}!important;
      border:1px solid {BORDER}!important;padding:1px 6px!important;
      font-family:{FONT_MONO}!important;font-size:.6rem!important;letter-spacing:.5px;
      height:22px!important}}
input:focus{{border-color:{ACCENT}!important;outline:none!important;box-shadow:none!important}}
input::placeholder{{color:{DIM}!important;font-size:.55rem!important;
      letter-spacing:1.5px;text-transform:uppercase}}
[data-testid="stSelectbox"]>div>div{{
  background:{PANEL}!important;border-color:{BORDER}!important;
  font-family:{FONT_PRIMARY}!important;font-size:.6rem!important;
  min-height:22px!important;max-height:22px!important;padding:0 4px!important}}
[data-testid="stSelectbox"] label{{display:none!important}}
[data-testid="stSelectbox"] svg{{fill:{DIM}!important;width:12px!important;height:12px!important}}
[data-testid="stToggle"] label span{{font-family:{FONT_PRIMARY}!important;
  font-size:.5rem!important;letter-spacing:1px;text-transform:uppercase;color:{DIM}}}
[data-testid="stToggle"] label{{gap:3px!important}}
[data-testid="stFormSubmitButton"] button{{
  background:transparent!important;color:{ACCENT}!important;
  border:1px solid {BORDER}!important;padding:0 5px!important;
  font-family:{FONT_MONO}!important;font-size:.6rem!important;
  min-height:22px!important;height:22px!important}}
[data-testid="stFormSubmitButton"] button:hover{{border-color:{ACCENT}!important}}
/* sidebar */
[data-testid="stSidebar"]{{background:{PANEL}!important;border-right:1px solid {BORDER}!important}}
[data-testid="stSidebar"] button{{
  background:transparent!important;color:{DIM}!important;
  border:1px solid {BORDER}!important;padding:2px 8px!important;
  font-family:{FONT_MONO}!important;font-size:.6rem!important;
  letter-spacing:1.5px;text-transform:uppercase}}
[data-testid="stSidebar"] button:hover{{color:{ACCENT}!important;border-color:{ACCENT}!important}}
[data-testid="stMultiSelect"]>div>div{{
  background:{PANEL}!important;border-color:{BORDER}!important;
  font-family:{FONT_PRIMARY}!important;font-size:.6rem!important}}
[data-testid="stSidebarCollapsedControl"]{{display:none!important}}
iframe{{border:none!important}}
</style>""", unsafe_allow_html=True)

# ── Data helpers (unchanged) ─────────────────────────────────────────────────
PERIOD   = {"1m":"1d","5m":"5d","15m":"5d","1h":"1mo","4h":"60d","1D":"1y","1W":"5y"}
INTERVAL = {"1m":"1m","5m":"5m","15m":"15m","1h":"1h","4h":"1h","1D":"1d","1W":"1wk"}

def _dc(s): return f"hsl({int(hashlib.md5(s.encode()).hexdigest()[:6],16)%360},65%,55%)"

@st.cache_data(ttl=300, show_spinner=False)
def fetch_ohlcv(tk, tf, ext):
    pp = ext and tf not in ("1D","1W")
    df = yf.download(tk, period=PERIOD.get(tf,"5d"),
                     interval=INTERVAL.get(tf,"15m"), prepost=pp, progress=False)
    if df.empty: return df
    if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.droplevel(1)
    if tf == "4h":
        df = df.resample("4h").agg(
            {"Open":"first","High":"max","Low":"min","Close":"last","Volume":"sum"}).dropna()
    df["SMA20"] = df["Close"].rolling(20).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
    return df

@st.cache_data(ttl=60, show_spinner=False)
def get_all_quotes(tup):
    tickers = list(tup)
    if not tickers: return {}
    df = yf.download(tickers, period="5d", interval="1d", progress=False)
    if df.empty: return {}
    out = {}
    for t in tickers:
        try:
            c = df["Close"][t].dropna() if isinstance(df.columns, pd.MultiIndex) else df["Close"].dropna()
            if len(c)>=2:
                p=float(c.iloc[-1]); pv=float(c.iloc[-2]); out[t]=(p,p-pv,(p-pv)/pv*100)
            elif len(c)==1: out[t]=(float(c.iloc[-1]),0.,0.)
        except: pass
    return out

@st.cache_data(ttl=30, show_spinner=False)
def get_ext_quote(tk):
    try:
        df=yf.download(tk,period="1d",interval="1m",prepost=True,progress=False)
        if isinstance(df.columns,pd.MultiIndex): df.columns=df.columns.droplevel(1)
        if not df.empty:
            return float(df["Close"].iloc[-1]), df.index[-1]
    except: pass
    return None,None

@st.cache_data(ttl=86400, show_spinner=False)
def get_info(tk):
    try:
        i=yf.Ticker(tk).info
        return (i.get("shortName",i.get("longName",tk)),i.get("exchange",""),
                i.get("sector",i.get("industry","")))
    except: return tk,"",""

def _cache_key(sym, tf, ext):
    return f"{sym}|{tf}|{1 if ext else 0}"

def _build_symbol_payload(tk, tf, ext):
    df_t = fetch_ohlcv(tk, tf, ext)
    effective_tf = tf
    effective_ext = ext
    if df_t.empty and tf not in ("1D", "1W"):
        df_t = fetch_ohlcv(tk, "1D", False)
        effective_tf = "1D"
        effective_ext = False
    if df_t.empty:
        return None
    if isinstance(df_t.columns, pd.MultiIndex):
        df_t.columns = df_t.columns.droplevel(1)

    L = df_t.iloc[-1]
    cl = float(L["Close"])
    pv = float(df_t["Close"].iloc[-2]) if len(df_t) > 1 else cl
    sv = float(L["SMA20"]) if pd.notna(L.get("SMA20")) else None
    ev = float(L["EMA50"]) if pd.notna(L.get("EMA50")) else None

    cnd, sma20, ema50 = [], [], []
    for ts, r in df_t.iterrows():
        t = int(ts.timestamp())
        cnd.append({
            "time": t,
            "open": round(float(r["Open"]), 2),
            "high": round(float(r["High"]), 2),
            "low": round(float(r["Low"]), 2),
            "close": round(float(r["Close"]), 2),
        })
        if pd.notna(r.get("SMA20")):
            sma20.append({"time": t, "value": round(float(r["SMA20"]), 2)})
        if pd.notna(r.get("EMA50")):
            ema50.append({"time": t, "value": round(float(r["EMA50"]), 2)})

    last_ts = df_t.index[-1]
    if effective_tf in ("1D", "1W"):
        session_df = df_t.tail(1)
    else:
        last_day = last_ts.date()
        session_df = df_t[df_t.index.date == last_day]
    session_high = float(session_df["High"].max()) if not session_df.empty else float(L["High"])
    session_low = float(session_df["Low"].min()) if not session_df.empty else float(L["Low"])
    if "Volume" in session_df.columns:
        session_vol = float(session_df["Volume"].sum())
        if pd.isna(session_vol):
            session_vol = None
    else:
        session_vol = None
    if pd.isna(session_high):
        session_high = float(L["High"])
    if pd.isna(session_low):
        session_low = float(L["Low"])
    time_str = last_ts.strftime("%H:%M")

    chg_val = cl - pv
    chg_pct = (chg_val / pv * 100) if pv else 0
    price_color = UP if chg_val >= 0 else DOWN
    chg_sign = "+" if chg_val >= 0 else ""
    name, ex_name, _ = get_info(tk)
    session_tag = "RTH" if effective_tf in ("1D", "1W") else ("EXT" if effective_ext else "RTH")
    meta_text = f"{ex_name} · {effective_tf.upper()} · {session_tag}" if ex_name else f"{effective_tf.upper()} · {session_tag}"

    return {
        "symbol": tk,
        "timeframe": effective_tf,
        "ext": effective_ext,
        "candles": cnd,
        "sma20": sma20,
        "ema50": ema50,
        "last": {
            "o": round(float(L["Open"]), 2),
            "h": round(float(L["High"]), 2),
            "l": round(float(L["Low"]), 2),
            "c": round(cl, 2),
            "s": round(sv, 2) if sv is not None else None,
            "e": round(ev, 2) if ev is not None else None,
        },
        "panel": {
            "open": round(float(L["Open"]), 2),
            "high": round(session_high, 2),
            "low": round(session_low, 2),
            "volume": round(session_vol, 0) if session_vol is not None else None,
            "time_str": time_str,
            "status": session_tag,
        },
        "meta_text": meta_text,
        "price_color": price_color,
        "chg_str": f"{chg_sign}{chg_val:,.2f}",
        "chg_pct_str": f"{chg_sign}{chg_pct:.2f}%",
    }

def _get_cached_payload(sym, tf, ext):
    cache = st.session_state.setdefault("_fv_cache", {})
    key = _cache_key(sym, tf, ext)
    if key in cache:
        return cache[key]
    payload = _build_symbol_payload(sym, tf, ext)
    if payload:
        cache[key] = payload
    return payload

SEARCH_ENDPOINT = "https://query2.finance.yahoo.com/v1/finance/search"
SEARCH_PORT = 8502
_SEARCH_SERVER_STARTED = False
UNIVERSE_TTL = 7 * 24 * 60 * 60
SYMBOL_CACHE_FILE = Path(__file__).with_name("symbol_universe.json")
_UNIVERSE_CACHE = {"data": None, "ts": 0}
DEFAULT_SYMBOLS = [
    {"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "MSFT", "name": "Microsoft Corp.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "NVDA", "name": "NVIDIA Corp.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "AMD", "name": "Advanced Micro Devices", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "AMZN", "name": "Amazon.com Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "GOOG", "name": "Alphabet Inc. Class C", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "META", "name": "Meta Platforms Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "TSLA", "name": "Tesla Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "NFLX", "name": "Netflix Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "ASML", "name": "ASML Holding N.V.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "BABA", "name": "Alibaba Group Holding Ltd.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "BRK-B", "name": "Berkshire Hathaway Inc. Class B", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "JNJ", "name": "Johnson & Johnson", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "V", "name": "Visa Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "JPM", "name": "JPMorgan Chase & Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "WMT", "name": "Walmart Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "PG", "name": "Procter & Gamble Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "MA", "name": "Mastercard Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "UNH", "name": "UnitedHealth Group Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "MCD", "name": "McDonald's Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "KO", "name": "Coca-Cola Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "PEP", "name": "PepsiCo Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "INTC", "name": "Intel Corp.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "ADBE", "name": "Adobe Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "CRM", "name": "Salesforce Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "ORCL", "name": "Oracle Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "T", "name": "AT&T Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "VZ", "name": "Verizon Communications Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "NKE", "name": "Nike Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "PYPL", "name": "PayPal Holdings Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "COST", "name": "Costco Wholesale Corp.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "CSCO", "name": "Cisco Systems Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "AVGO", "name": "Broadcom Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "TXN", "name": "Texas Instruments Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "XOM", "name": "Exxon Mobil Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "CVX", "name": "Chevron Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "PFE", "name": "Pfizer Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "MRVL", "name": "Marvell Technology Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "AMD", "name": "Advanced Micro Devices", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "HON", "name": "Honeywell International Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "LOW", "name": "Lowe's Companies Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "MMM", "name": "3M Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "GE", "name": "General Electric Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "BA", "name": "Boeing Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "CAT", "name": "Caterpillar Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "ABNB", "name": "Airbnb Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "SNOW", "name": "Snowflake Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "SBUX", "name": "Starbucks Corp.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "RTX", "name": "RTX Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "SNY", "name": "Sanofi", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "TMUS", "name": "T-Mobile US Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "UPS", "name": "United Parcel Service Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "FDX", "name": "FedEx Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "TGT", "name": "Target Corp.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "BMY", "name": "Bristol-Myers Squibb Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "DE", "name": "Deere & Co.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "CAT", "name": "Caterpillar Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "LIN", "name": "Linde plc", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "CHTR", "name": "Charter Communications Inc.", "exchange": "NASDAQ", "type": "EQUITY"},
    {"symbol": "NOW", "name": "ServiceNow Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "SPGI", "name": "S&P Global Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "ICE", "name": "Intercontinental Exchange Inc.", "exchange": "NYSE", "type": "EQUITY"},
    {"symbol": "BLK", "name": "BlackRock Inc.", "exchange": "NYSE", "type": "EQUITY"},
]

def _search_tickers_uncached(query):
    q = str(query or "").strip()
    if not q or len(q) < 2:
        return []
    params = {"q": q, "quotesCount": 8, "newsCount": 0, "lang": "en-US", "region": "US"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    try:
        resp = requests.get(SEARCH_ENDPOINT, params=params, headers=headers, timeout=6)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        payload = {}
    results = []
    for item in payload.get("quotes", []):
        sym = item.get("symbol") or item.get("Symbol")
        if not sym:
            continue
        clean = _norm_symbol(sym)
        if not clean:
            continue
        results.append({
            "symbol": clean,
            "name": item.get("shortname") or item.get("longname") or item.get("name") or "",
            "exchange": item.get("exchDisp") or item.get("exchange") or item.get("exch") or "",
            "type": item.get("quoteType") or item.get("type") or "",
        })
    if results:
        return results
    # Fallback to Yahoo autocomplete API
    try:
        auto_resp = requests.get(
            "https://autoc.finance.yahoo.com/autoc",
            params={"query": q, "region": 1, "lang": "en"},
            headers=headers,
            timeout=6,
        )
        auto_resp.raise_for_status()
        auto_payload = auto_resp.json()
    except Exception:
        auto_payload = {}
    for item in auto_payload.get("ResultSet", {}).get("Result", []):
        sym = item.get("symbol") or item.get("Symbol")
        if not sym:
            continue
        clean = _norm_symbol(sym)
        if not clean:
            continue
        results.append({
            "symbol": clean,
            "name": item.get("name") or item.get("Name") or "",
            "exchange": item.get("exchDisp") or item.get("exch") or "",
            "type": item.get("type") or "",
        })
    if results:
        return results
    return search_universe(q)

def _parse_nasdaq_traded(text):
    rows = []
    for line in text.splitlines():
        if not line or line.startswith("Symbol|") or line.startswith("File Creation Time"):
            continue
        parts = line.split("|")
        if len(parts) < 2:
            continue
        sym = _norm_symbol(parts[0])
        if not sym:
            continue
        name = parts[1].strip()
        rows.append({"symbol": sym, "name": name, "exchange": "NASDAQ", "type": "EQUITY"})
    return rows

def _parse_other_listed(text):
    rows = []
    for line in text.splitlines():
        if not line or line.startswith("ACT Symbol|") or line.startswith("File Creation Time"):
            continue
        parts = line.split("|")
        if len(parts) < 3:
            continue
        sym = _norm_symbol(parts[0])
        if not sym:
            continue
        name = parts[1].strip()
        exch_code = parts[2].strip()
        exch_map = {"N": "NYSE", "A": "NYSE American", "P": "NYSE Arca", "Z": "BATS", "V": "IEX"}
        exch = exch_map.get(exch_code, exch_code)
        rows.append({"symbol": sym, "name": name, "exchange": exch, "type": "EQUITY"})
    return rows

def load_symbol_universe():
    now = time.time()
    if _UNIVERSE_CACHE["data"] and now - _UNIVERSE_CACHE["ts"] < UNIVERSE_TTL:
        return _UNIVERSE_CACHE["data"]
    try:
        if SYMBOL_CACHE_FILE.exists():
            age = now - SYMBOL_CACHE_FILE.stat().st_mtime
            if age < UNIVERSE_TTL:
                data = json.loads(SYMBOL_CACHE_FILE.read_text())
                if isinstance(data, list) and data:
                    _UNIVERSE_CACHE["data"] = data
                    _UNIVERSE_CACHE["ts"] = now
                    return data
    except Exception:
        pass
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/plain, */*",
    }
    rows = []
    try:
        nasdaq_resp = requests.get(
            "https://ftp.nasdaqtrader.com/SymbolDirectory/nasdaqtraded.txt",
            headers=headers,
            timeout=8,
        )
        if nasdaq_resp.ok:
            rows.extend(_parse_nasdaq_traded(nasdaq_resp.text))
    except Exception:
        pass
    try:
        other_resp = requests.get(
            "https://ftp.nasdaqtrader.com/SymbolDirectory/otherlisted.txt",
            headers=headers,
            timeout=8,
        )
        if other_resp.ok:
            rows.extend(_parse_other_listed(other_resp.text))
    except Exception:
        pass
    if rows:
        uniq = {}
        for item in rows:
            sym = item["symbol"]
            if sym not in uniq:
                uniq[sym] = item
        data = list(uniq.values())
        try:
            SYMBOL_CACHE_FILE.write_text(json.dumps(data))
        except Exception:
            pass
        _UNIVERSE_CACHE["data"] = data
        _UNIVERSE_CACHE["ts"] = now
        return data
    _UNIVERSE_CACHE["data"] = DEFAULT_SYMBOLS
    _UNIVERSE_CACHE["ts"] = now
    return DEFAULT_SYMBOLS

def search_universe(query):
    q = str(query or "").strip().upper()
    if len(q) < 2:
        return []
    universe = load_symbol_universe()
    matches = []
    for item in universe:
        sym = item.get("symbol", "").upper()
        name = item.get("name", "").upper()
        if sym.startswith(q) or q in name:
            matches.append(item)
        if len(matches) >= 12:
            break
    return matches

@st.cache_data(ttl=900, show_spinner=False)
def search_tickers(query):
    return _search_tickers_uncached(query)

class SearchHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path != "/search":
            self.send_response(404)
            self._send_cors()
            self.end_headers()
            return
        params = parse_qs(parsed.query or "")
        q = params.get("q", [""])[0]
        results = _search_tickers_uncached(q)
        body = json.dumps(results)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, format, *args):
        return

def ensure_search_server():
    global _SEARCH_SERVER_STARTED
    if _SEARCH_SERVER_STARTED:
        return
    try:
        httpd = HTTPServer(("0.0.0.0", SEARCH_PORT), SearchHandler)
    except OSError:
        _SEARCH_SERVER_STARTED = True
        return
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    _SEARCH_SERVER_STARTED = True

ensure_search_server()

# ── Sparkline helpers ────────────────────────────────────────────────────────
@st.cache_data(ttl=300, show_spinner=False)
def get_sparklines(tup):
    tickers = list(tup)
    if not tickers: return {}
    df = yf.download(tickers, period="1mo", interval="1d", progress=False)
    if df.empty: return {}
    out = {}
    for t in tickers:
        try:
            if isinstance(df.columns, pd.MultiIndex):
                c = df["Close"][t].dropna()
            else:
                c = df["Close"].dropna()
            out[t] = [round(float(v), 2) for v in c.values[-20:]]
        except: pass
    return out

def build_sparkline_svg(prices, color):
    if not prices or len(prices) < 2: return ""
    w, h = 40, 20
    mn, mx = min(prices), max(prices)
    rng = mx - mn if mx != mn else 1
    pts = []
    for i, p in enumerate(prices):
        x = round(i / (len(prices) - 1) * w, 1)
        y = round(h - ((p - mn) / rng) * (h - 2) - 1, 1)
        pts.append(f"{x},{y}")
    return (f'<svg class="sym-chart" viewBox="0 0 {w} {h}">'
            f'<polyline points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="1.5"/></svg>')

# ── Build HTML component ─────────────────────────────────────────────────────
def build_html_component(data):
    sel = data["selected"]
    tf = data["timeframe"]
    wl = data["watchlist"]
    quotes = data["quotes"]
    symbol_data_json = json.dumps(data["symbol_data"])
    watchlist_json = json.dumps(wl)
    debug_info = data.get("debug_info") or {}
    debug_enabled = data.get("debug_enabled", False)
    last_event_payload = debug_info.get("last_event")
    last_event_ts = debug_info.get("last_event_ts") or "--"
    last_event_text = json.dumps(last_event_payload, indent=2) if last_event_payload is not None else "None"
    debug_panel = ""
    if debug_enabled:
        debug_panel = f"""
        <div id="fv-debug-panel">
            <div class="fv-debug-line"><span class="fv-debug-label">componentReady</span>
                <span class="fv-debug-value">{'YES' if debug_info.get('ready') else 'NO'}</span>
            </div>
            <div class="fv-debug-line"><span class="fv-debug-label">lastEventTs</span>
                <span class="fv-debug-value">{html.escape(str(last_event_ts))}</span>
            </div>
            <div class="fv-debug-line fv-debug-block">
                <span class="fv-debug-label">lastEvent</span>
                <pre class="fv-debug-pre">{html.escape(last_event_text)}</pre>
            </div>
        </div>
        """
    sparklines = data["sparklines"]
    ticker_names = data["ticker_names"]
    last = data["last"]
    ext_flag = "true" if data.get("is_ext") else "false"
    data_status = data.get("data_status", {})
    missing_symbol = data.get("missing_symbol") or ""
    missing_message = data.get("missing_message") or ""
    watchlist_message = data.get("watchlist_message") or ""
    search_query = data.get("search_query") or ""
    search_results = data.get("search_results") or []
    search_value = html.escape(search_query)
    search_query_js = json.dumps(search_query)
    symbol_universe = data.get("symbol_universe") or []
    symbol_universe_json = json.dumps(symbol_universe)
    search_rows = ""
    if search_query:
        if search_results:
            for item in search_results:
                sym = html.escape(item.get("symbol", ""))
                name = html.escape(item.get("name", ""))
                exch = html.escape(item.get("exchange", ""))
                qtype = html.escape(item.get("type", ""))
                meta_parts = " · ".join([p for p in [exch, qtype] if p])
                search_rows += f"""
                <div class="search-item" data-symbol="{sym}">
                    <div class="search-main">
                        <div class="search-symbol">{sym}</div>
                        <div class="search-name">{name}</div>
                    </div>
                    <div class="search-meta">{meta_parts}</div>
                </div>
                """
        else:
            search_rows = """
            <div class="search-empty">No matches. Use + to add exact ticker.</div>
            """
    search_results_class = "search-results" + (" active" if len(search_query) >= 2 else "")
    symbol_menu_rows = ""
    for tk in wl:
        name = html.escape(ticker_names.get(tk, tk))
        sym = html.escape(tk)
        symbol_menu_rows += f"""
        <div class="symbol-menu-item" data-symbol="{sym}" data-name="{name}">
            <div class="symbol-menu-symbol">{sym}</div>
            <div class="symbol-menu-name">{name}</div>
        </div>
        """
    
    # Header format
    meta_text = data["meta_text"]
    
    # Watchlist generation
    wl_rows = ""
    for tk in wl:
        q = quotes.get(tk, (None, None, None))
        px, cg, pt = q
        name = ticker_names.get(tk, tk)
        
        # Determine colors and classes
        is_up = cg >= 0 if cg is not None else False
        color_hex = UP if is_up else DOWN
        dot_cls = "up" if is_up else "down"
        change_cls = "change-up" if is_up else "change-down"
        sign = "+" if is_up else ""
        active_cls = " active" if tk == sel else ""
        no_data_cls = " no-data" if not data_status.get(tk, False) else ""
        no_data_tag = "<div class=\"no-data-tag\">NO DATA</div>" if not data_status.get(tk, False) else ""
        
        # Sparkline
        sp = sparklines.get(tk, [])
        spark_svg = build_sparkline_svg(sp, color_hex)
        
        if px is not None:
            wl_rows += f"""
            <div class="watch-item{active_cls}{no_data_cls}" data-symbol="{tk}" data-name="{name}" onclick="switchSymbol(event, '{tk}')">
                <div class="watch-left">
                    <div class="drag-handle"></div>
                    <div class="sym-dot {dot_cls}"></div>
                    <div class="sym-info">
                        <div class="sym-symbol">{tk}</div>
                        <div class="sym-name">{name[:15]}</div>
                        {no_data_tag}
                    </div>
                </div>
                {spark_svg}
                <div class="sym-price">
                    <div class="sym-last">{px:,.2f}</div>
                    <div class="sym-change {change_cls}">{sign}{pt:.2f}%</div>
                </div>
                <button class="watch-remove" onclick="removeSymbol(event, '{tk}')">x</button>
            </div>
            """
        else:
            wl_rows += f"""
            <div class="watch-item{active_cls}{no_data_cls}" data-symbol="{tk}" data-name="{name}" onclick="switchSymbol(event, '{tk}')">
                <div class="watch-left">
                    <div class="drag-handle"></div>
                    <div class="sym-dot down"></div>
                    <div class="sym-info">
                        <div class="sym-symbol">{tk}</div>
                        <div class="sym-name">{name[:15]}</div>
                        {no_data_tag}
                    </div>
                </div>
                {spark_svg}
                <div class="sym-price">
                    <div class="sym-last">---</div>
                    <div class="sym-change">--%</div>
                </div>
                <button class="watch-remove" onclick="removeSymbol(event, '{tk}')">x</button>
            </div>
            """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Whomp FadingView</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/split.js@1.6.5/dist/split.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js"></script>
    <script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        
        :root {{
            --bg-dark: {BG};
            --bg-panel: {PANEL};
            --border: {BORDER};
            --text-primary: {TXT};
            --text-secondary: {DIM};
            --up: {UP};
            --down: {DOWN};
            --accent: {ACCENT};
            --font-sans: {FONT_PRIMARY};
            --font-mono: {FONT_MONO};
        }}

        body {{
            background:
              radial-gradient(1200px 600px at 20% -10%, rgba(0, 208, 132, 0.08), transparent 60%),
              radial-gradient(900px 600px at 85% 0%, rgba(60, 196, 255, 0.06), transparent 55%),
              var(--bg-dark);
            color: var(--text-primary);
            font-family: var(--font-sans);
            height: 100vh;
            overflow: hidden;
            font-size: 13px;
        }}

        #fv-debug-panel {{
            position: fixed;
            top: 8px;
            right: 8px;
            z-index: 9999;
            background: rgba(11, 15, 13, 0.9);
            border: 1px solid var(--border);
            padding: 8px 10px;
            font-family: var(--font-mono);
            font-size: 9px;
            color: var(--text-primary);
            max-width: 320px;
            box-shadow: 0 8px 18px rgba(0,0,0,0.4);
        }}

        .fv-debug-line {{
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 4px;
        }}

        .fv-debug-block {{
            display: block;
        }}

        .fv-debug-label {{
            color: var(--text-secondary);
            letter-spacing: 0.6px;
            text-transform: uppercase;
        }}

        .fv-debug-value {{
            color: var(--accent);
            font-weight: 600;
        }}

        .fv-debug-pre {{
            margin-top: 4px;
            padding: 4px 6px;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid var(--border);
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 140px;
            overflow: auto;
        }}

        #fv-fatal-banner {{
            position: fixed;
            left: 50%;
            transform: translateX(-50%);
            top: 10px;
            z-index: 10000;
            background: #2a0f0f;
            color: #ffb1b1;
            border: 1px solid #7a2a2a;
            padding: 10px 14px;
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 0.4px;
            text-transform: none;
            display: none;
        }}

        /* HEADER - EXACT TRADINGVIEW SPEC */
        .top-header {{
            height: 36px;
            background: rgba(15, 23, 20, 0.92);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            padding: 0 8px;
            justify-content: space-between;
            backdrop-filter: blur(10px);
            box-shadow: 0 10px 24px rgba(0,0,0,0.35);
            position: relative;
            z-index: 10;
            overflow: visible;
        }}

        .header-left {{
            display: flex;
            align-items: center;
            gap: 12px;
            overflow: visible;
        }}

        .header-right {{
            display: flex;
            align-items: center;
            gap: 14px;
        }}

        .header-controls {{
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 10px;
            color: var(--text-secondary);
        }}

        .tf-group {{
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 1px 3px;
            border: 1px solid var(--border);
            background: rgba(0, 0, 0, 0.25);
        }}

        .tf-btn {{
            border: 1px solid transparent;
            background: transparent;
            color: var(--text-secondary);
            font-size: 8px;
            letter-spacing: 1px;
            text-transform: uppercase;
            padding: 1px 2px;
            cursor: pointer;
            font-family: var(--font-mono);
        }}

        .tf-btn.active {{
            color: var(--text-primary);
            border-color: var(--accent);
            box-shadow: inset 0 0 0 1px rgba(0, 208, 132, 0.35);
        }}

        .ext-toggle {{
            display: inline-flex;
            align-items: center;
            gap: 6px;
            border: 1px solid var(--border);
            padding: 1px 5px;
            font-size: 8px;
            letter-spacing: 1.2px;
            text-transform: uppercase;
            color: var(--text-secondary);
            background: rgba(0, 0, 0, 0.25);
            cursor: pointer;
            font-family: var(--font-mono);
        }}

        .ext-toggle.active {{
            color: var(--text-primary);
            border-color: var(--accent);
            box-shadow: inset 0 0 0 1px rgba(0, 208, 132, 0.35);
        }}

        .ext-dot {{
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--text-secondary);
        }}

        .ext-toggle.active .ext-dot {{
            background: var(--accent);
            box-shadow: 0 0 8px rgba(0, 208, 132, 0.6);
        }}

        .brand {{
            display: flex;
            align-items: center;
            gap: 8px;
            padding-right: 10px;
            border-right: 1px solid var(--border);
        }}

        .brand-mark {{
            width: 16px;
            height: 16px;
            filter: drop-shadow(0 0 8px rgba(0, 208, 132, 0.4));
        }}

        .brand-text {{
            display: flex;
            flex-direction: column;
            line-height: 1;
        }}

        .brand-name {{
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.6px;
            text-transform: lowercase;
        }}

        .brand-sub {{
            font-size: 8px;
            color: var(--text-secondary);
            letter-spacing: 1.4px;
            text-transform: uppercase;
            margin-top: 2px;
        }}

        /* Symbol Block - Vertical Stack */
        .symbol-block {{
            display: flex;
            flex-direction: column;
            line-height: 1.2;
            position: relative;
        }}

        .symbol-name {{
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary);
            letter-spacing: 0.2px;
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
        }}

        .symbol-meta {{
            font-size: 9px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1.2px;
        }}

        .symbol-menu {{
            position: absolute;
            top: 36px;
            left: 0;
            width: 220px;
            background: rgba(11, 15, 13, 0.98);
            border: 1px solid var(--border);
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
            display: none;
            z-index: 20;
        }}

        .symbol-menu.active {{
            display: block;
        }}

        .symbol-menu-header {{
            padding: 6px 8px;
            font-size: 9px;
            letter-spacing: 1.4px;
            text-transform: uppercase;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--border);
        }}

        .symbol-menu-search {{
            padding: 6px 8px;
            border-bottom: 1px solid var(--border);
        }}

        .symbol-menu-search input {{
            width: 100%;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid var(--border);
            color: var(--text-primary);
            font-size: 10px;
            padding: 4px 6px;
            font-family: var(--font-mono);
            letter-spacing: 0.8px;
            text-transform: uppercase;
        }}

        .symbol-menu-list {{
            max-height: 180px;
            overflow-y: auto;
        }}

        .symbol-menu-item {{
            padding: 6px 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            cursor: pointer;
        }}

        .symbol-menu-item:hover {{
            background: rgba(0, 208, 132, 0.1);
        }}

        .symbol-menu-symbol {{
            font-family: var(--font-mono);
            font-size: 10px;
            color: var(--text-primary);
        }}

        .symbol-menu-name {{
            font-size: 9px;
            color: var(--text-secondary);
        }}

        .symbol-menu-footer {{
            padding: 6px 8px;
            font-size: 9px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
        }}

        /* OHLC Block */
        .ohlc-block {{
            display: flex;
            align-items: center;
            gap: 12px;
            font-family: var(--font-mono);
            font-size: 10px;
        }}

        .ohlc-item {{
            display: flex;
            gap: 4px;
        }}

        .ohlc-label {{
            color: var(--text-secondary);
        }}

        .ohlc-value {{
            color: var(--text-primary);
        }}

        .ohlc-close {{
            color: var(--up);
            font-weight: 700;
        }}

        .sma-tag {{
            color: {BLUE};
            margin-left: 8px;
            font-weight: 600;
        }}

        /* Price Block - Right Side */
        .price-block {{
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            line-height: 1.2;
        }}

        .main-price {{
            font-size: 14px;
            font-weight: 700;
            font-family: var(--font-mono);
            color: var(--up);
            letter-spacing: -0.2px;
        }}

        .price-change {{
            font-size: 10px;
            color: var(--up);
            font-weight: 600;
            font-family: var(--font-mono);
        }}

        /* MAIN LAYOUT */
        .main-container {{
            display: flex;
            height: calc(100vh - 36px);
        }}

        /* LEFT TOOLBAR */
        .left-toolbar {{
            width: 48px;
            background: rgba(15, 23, 20, 0.92);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 8px 0;
            gap: 4px;
            flex-shrink: 0;
            box-shadow: inset -1px 0 0 rgba(0,0,0,0.2);
        }}

        .tool-btn {{
            width: 36px;
            height: 36px;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            transition: transform 0.12s ease, background 0.12s ease, color 0.12s ease;
        }}

        .tool-btn:hover {{
            background: rgba(0, 208, 132, 0.12);
            color: var(--text-primary);
            transform: translateY(-1px);
        }}

        /* CHART AREA */
        .chart-section {{
            flex: 1;
            position: relative;
            background: linear-gradient(180deg, rgba(15, 23, 20, 0.6), rgba(11, 15, 13, 0.95));
            min-width: 400px;
        }}

        #chart-container {{
            width: 100%;
            height: 100%;
        }}

        .chart-watermark {{
            position: absolute;
            left: 14px;
            bottom: 10px;
            font-size: 11px;
            letter-spacing: 1.6px;
            text-transform: uppercase;
            color: rgba(0, 208, 132, 0.55);
            text-shadow: 0 0 12px rgba(0, 208, 132, 0.35);
            pointer-events: none;
        }}

        .indicator-panel {{
            position: absolute;
            top: 6px;
            left: 8px;
            background: rgba(11, 15, 13, 0.92);
            border: 1px solid var(--border);
            padding: 6px 8px;
            font-size: 11px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            z-index: 5;
            box-shadow: 0 12px 24px rgba(0,0,0,0.35);
        }}

        .indicator-title {{
            font-size: 10px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1.2px;
        }}

        .indicator-panel label {{
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--text-secondary);
            cursor: pointer;
            user-select: none;
        }}

        .indicator-panel input {{
            accent-color: var(--accent);
            width: 12px;
            height: 12px;
        }}

        .quote-panel {{
            position: relative;
            background: rgba(11, 15, 13, 0.92);
            border: 1px solid var(--border);
            padding: 10px 12px;
            min-width: 0;
            z-index: 2;
            font-family: var(--font-mono);
            box-shadow: 0 10px 24px rgba(0,0,0,0.35);
        }}

        .watchlist-footer {{
            padding: 8px 10px;
            border-top: 1px solid var(--border);
            background: rgba(11, 15, 13, 0.92);
        }}

        .qp-top {{
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
        }}

        .qp-symbol {{
            font-size: 12px;
            font-weight: 700;
            color: var(--text-primary);
        }}

        .qp-status {{
            font-size: 10px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1.4px;
        }}

        .qp-price {{
            font-size: 16px;
            font-weight: 700;
            color: var(--text-primary);
        }}

        .qp-change {{
            font-size: 11px;
            margin-top: 2px;
        }}

        .qp-grid {{
            margin-top: 8px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px 10px;
            font-size: 11px;
            color: var(--text-secondary);
        }}

        .qp-row {{
            display: flex;
            align-items: center;
            justify-content: space-between;
        }}

        /* WATCHLIST */
        .watchlist-section {{
            width: 280px;
            min-width: 200px;
            max-width: 500px;
            background: linear-gradient(180deg, rgba(15, 23, 20, 0.95), rgba(11, 15, 13, 0.95));
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
        }}

        .watchlist-header {{
            padding: 6px 10px;
            border-bottom: 1px solid var(--border);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            color: var(--text-secondary);
            letter-spacing: 1.4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}

        .watchlist-controls {{
            padding: 6px 10px;
            border-bottom: 1px solid var(--border);
            display: flex;
            gap: 6px;
            align-items: center;
        }}

        .watchlist-controls input {{
            flex: 1;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 4px 6px;
            font-size: 10px;
            font-family: var(--font-mono);
            letter-spacing: 0.8px;
            text-transform: uppercase;
        }}

        .watchlist-controls input::placeholder {{
            color: var(--text-secondary);
        }}

        .watch-search {{
            width: 32px;
            height: 22px;
            border: 1px solid var(--border);
            background: rgba(0, 0, 0, 0.25);
            color: var(--text-secondary);
            font-size: 9px;
            letter-spacing: 1px;
            text-transform: uppercase;
            cursor: pointer;
            font-family: var(--font-mono);
        }}

        .watch-search:hover {{
            color: var(--text-primary);
            border-color: var(--accent);
        }}

        .watch-add {{
            width: 22px;
            height: 22px;
            border: 1px solid var(--border);
            background: rgba(0, 0, 0, 0.25);
            color: var(--text-secondary);
            font-size: 12px;
            cursor: pointer;
        }}

        .watch-add:hover {{
            color: var(--text-primary);
            border-color: var(--accent);
        }}

        .watchlist-hint {{
            padding: 4px 10px 6px;
            font-size: 9px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: 1px solid var(--border);
        }}

        .search-results {{
            border-bottom: 1px solid var(--border);
            display: none;
            max-height: 160px;
            overflow-y: auto;
        }}

        .search-results.active {{
            display: block;
        }}

        .search-item {{
            padding: 6px 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }}

        .search-item:hover {{
            background: rgba(0, 208, 132, 0.08);
        }}

        .search-main {{
            display: flex;
            flex-direction: column;
            gap: 2px;
        }}

        .search-symbol {{
            font-family: var(--font-mono);
            font-size: 10px;
            letter-spacing: 0.8px;
            color: var(--text-primary);
        }}

        .search-name {{
            font-size: 9px;
            color: var(--text-secondary);
        }}

        .search-meta {{
            font-size: 8px;
            color: var(--text-secondary);
            letter-spacing: 1px;
            text-transform: uppercase;
        }}

        .search-empty {{
            padding: 6px 10px;
            font-size: 9px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
        }}

        .watchlist-count {{
            font-size: 10px;
            color: var(--text-secondary);
        }}

        #watchlist-items {{
            overflow-y: auto;
            flex: 1;
        }}

        .watch-item {{
            padding: 10px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.1s;
            position: relative;
        }}

        .watch-item:hover {{
            background: rgba(0, 208, 132, 0.06);
        }}

        .watch-item.active {{
            background: rgba(0, 208, 132, 0.12);
            box-shadow: inset 3px 0 0 var(--accent);
        }}

        .watch-item.no-data {{
            opacity: 0.6;
        }}

        .watch-item.dragging {{
            opacity: 0.5;
            background: rgba(0, 208, 132, 0.15);
            border-left: 3px solid var(--accent);
        }}

        .no-data-tag {{
            font-size: 8px;
            letter-spacing: 1px;
            text-transform: uppercase;
            color: var(--text-secondary);
            margin-top: 2px;
        }}

        .watch-remove {{
            margin-left: 6px;
            border: 1px solid transparent;
            background: transparent;
            color: var(--text-secondary);
            font-size: 10px;
            cursor: pointer;
            opacity: 0;
        }}

        .watch-item:hover .watch-remove {{
            opacity: 0.7;
        }}

        .watch-remove:hover {{
            opacity: 1;
            color: var(--text-primary);
            border-color: var(--border);
        }}

        .watchlist-warning {{
            padding: 6px 10px;
            border-bottom: 1px solid var(--border);
            font-size: 10px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1.2px;
            background: rgba(0, 0, 0, 0.2);
            display: none;
        }}

        .watch-left {{
            display: flex;
            align-items: center;
            gap: 8px;
        }}

        .drag-handle {{
            width: 6px;
            height: 12px;
            display: flex;
            flex-direction: column;
            gap: 2px;
            opacity: 0;
            transition: opacity 0.2s;
            cursor: grab;
            padding: 2px;
        }}

        .watch-item:hover .drag-handle {{
            opacity: 0.4;
        }}

        .drag-handle::before,
        .drag-handle::after {{
            content: '';
            width: 100%;
            height: 2px;
            background: var(--text-secondary);
            box-shadow: 0 4px 0 var(--text-secondary);
        }}

        .sym-dot {{
            width: 5px;
            height: 5px;
            border-radius: 50%;
            flex-shrink: 0;
        }}

        .sym-dot.up {{ background: var(--up); }}
        .sym-dot.down {{ background: var(--down); }}

        .sym-info {{
            display: flex;
            flex-direction: column;
        }}

        .sym-symbol {{
            font-weight: 700;
            font-size: 12px;
            color: var(--text-primary);
            letter-spacing: 0.6px;
        }}

        .sym-name {{
            font-size: 10px;
            color: var(--text-secondary);
            max-width: 80px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            letter-spacing: 0.4px;
        }}

        .sym-chart {{
            width: 40px;
            height: 20px;
            opacity: 0.6;
        }}

        .sym-price {{
            text-align: right;
            font-family: var(--font-mono);
        }}

        .sym-last {{
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary);
        }}

        .sym-change {{
            font-size: 11px;
            margin-top: 2px;
        }}

        .change-up {{ color: var(--up); }}
        .change-down {{ color: var(--down); }}

        /* Gutter for resizing */
        .gutter {{
            background-color: rgba(27, 42, 36, 0.8);
            cursor: col-resize;
        }}

        .gutter:hover {{
            background-color: var(--accent);
        }}

        /* Scrollbar */
        ::-webkit-scrollbar {{ width: 6px; }}
        ::-webkit-scrollbar-track {{ background: transparent; }}
        ::-webkit-scrollbar-thumb {{ background: #363a45; border-radius: 3px; }}
    </style>
</head>
<body>
    {debug_panel}
    <div id="fv-fatal-banner"></div>

    <!-- EXACT TRADINGVIEW HEADER -->
        <div class="top-header">
        <div class="header-left">
            <div class="brand">
                <svg class="brand-mark" viewBox="0 0 24 24" fill="none">
                    <path d="M2 13.5h4l2.2-4.2 3.6 8 2.6-6 1.9 4.2H22" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="6" cy="13.5" r="1.6" fill="var(--accent)"/>
                </svg>
                <div class="brand-text">
                    <div class="brand-name">whomp</div>
                    <div class="brand-sub">Alpha AI</div>
                </div>
            </div>
            <div class="symbol-block">
                <div class="symbol-name" id="symbolToggle">
                    <span id="symbolName">{sel}</span>
                    <span style="font-size: 10px; color: var(--text-secondary);">▼</span>
                </div>
                <div class="symbol-meta" id="symbolMeta">{meta_text}</div>
                <div class="symbol-menu" id="symbolMenu">
                    <div class="symbol-menu-header">Symbols</div>
                    <div class="symbol-menu-search">
                        <input id="symbolMenuSearch" placeholder="Filter watchlist" />
                    </div>
                    <div class="symbol-menu-list" id="symbolMenuList">
                        {symbol_menu_rows}
                    </div>
                    <div class="symbol-menu-footer">Use watchlist search for global tickers</div>
                </div>
            </div>

            <div class="ohlc-block">
                <div class="ohlc-item">
                    <span class="ohlc-label">O</span>
                    <span class="ohlc-value" id="vO">{last['o']}</span>
                </div>
                <div class="ohlc-item">
                    <span class="ohlc-label">H</span>
                    <span class="ohlc-value" id="vH">{last['h']}</span>
                </div>
                <div class="ohlc-item">
                    <span class="ohlc-label">L</span>
                    <span class="ohlc-value" id="vL">{last['l']}</span>
                </div>
                <div class="ohlc-item">
                    <span class="ohlc-label">C</span>
                    <span class="ohlc-close" id="vC">{last['c']}</span>
                </div>
                <div class="ohlc-item sma-tag">
                    <span>SMA 20</span>
                    <span style="color: {BLUE};" id="vS">{last['s']}</span>
                </div>
            </div>
        </div>

        <div class="header-right">
            <div class="header-controls">
                <div class="tf-group">
                    <button class="tf-btn" data-tf="1m">1m</button>
                    <button class="tf-btn" data-tf="5m">5m</button>
                    <button class="tf-btn" data-tf="15m">15m</button>
                    <button class="tf-btn" data-tf="1h">1h</button>
                    <button class="tf-btn" data-tf="4h">4h</button>
                    <button class="tf-btn" data-tf="1D">1D</button>
                    <button class="tf-btn" data-tf="1W">1W</button>
                </div>
                <button class="ext-toggle" id="extToggle">
                    <span class="ext-dot"></span>
                    EXT
                </button>
            </div>
            <div class="price-block">
                <div class="main-price" style="color: {data['price_color']};" id="vBigP">{last['c']}</div>
                <div class="price-change" style="color: {data['price_color']};" id="priceChange">{data['chg_str']} ({data['chg_pct_str']})</div>
            </div>
        </div>
    </div>

    <div class="main-container">
        <!-- Left Tools -->
        <div class="left-toolbar">
            <button class="tool-btn">↖</button>
            <button class="tool-btn">⧠</button>
            <button class="tool-btn">📐</button>
            <button class="tool-btn">📝</button>
            <button class="tool-btn">✕</button>
        </div>

        <!-- Chart Section -->
        <div class="chart-section" id="chart-panel">
            <div id="chart-container"></div>
            <div class="chart-watermark">whomp</div>
            <div class="indicator-panel">
                <div class="indicator-title">Indicators</div>
                <label><input type="checkbox" id="toggleSMA" checked> SMA 20</label>
                <label><input type="checkbox" id="toggleEMA"> EMA 50</label>
            </div>
        </div>

        <!-- Watchlist Section -->
        <div class="watchlist-section" id="watchlist-panel">
            <div class="watchlist-header">
                <span>Watchlist</span>
                <span class="watchlist-count">{len(wl)} Active</span>
            </div>
            <div class="watchlist-controls">
                <input id="watchSearch" placeholder="Search tickers (type 2+)" value="{search_value}" />
                <button class="watch-search" id="watchSearchBtn">Go</button>
                <button class="watch-add" id="watchAddBtn">+</button>
            </div>
            <div class="watchlist-hint">Enter = add top result · + = add exact ticker</div>
            <div class="{search_results_class}" id="searchResults">
                {search_rows}
            </div>
            <div class="watchlist-warning" id="dataWarning"></div>
            <div id="watchlist-items">
                {wl_rows}
            </div>
            <div class="watchlist-footer">
                <div class="quote-panel" id="quote-panel">
                    <div class="qp-top">
                        <div class="qp-symbol" id="qpSymbol">{sel}</div>
                        <div class="qp-status" id="qpStatus">{data['panel_fmt']['status']}</div>
                    </div>
                    <div class="qp-price" id="qpPrice">{last['c']}</div>
                    <div class="qp-change" id="qpChange">{data['chg_str']} ({data['chg_pct_str']})</div>
                    <div class="qp-grid">
                        <div class="qp-row"><span>O</span><span id="qpOpen">{data['panel_fmt']['open']}</span></div>
                        <div class="qp-row"><span>H</span><span id="qpHigh">{data['panel_fmt']['high']}</span></div>
                        <div class="qp-row"><span>L</span><span id="qpLow">{data['panel_fmt']['low']}</span></div>
                        <div class="qp-row"><span>Vol</span><span id="qpVol">{data['panel_fmt']['volume']}</span></div>
                        <div class="qp-row"><span>Time</span><span id="qpTime">{data['panel_fmt']['time_str']}</span></div>
                        <div class="qp-row"><span>EMA</span><span id="qpEma">{data['panel_fmt']['ema']}</span></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        if (window.location.hostname === '0.0.0.0') {{
            var redirectUrl = new URL(window.location.href);
            redirectUrl.hostname = 'localhost';
            window.location.replace(redirectUrl.toString());
        }}
        var symbolData = {symbol_data_json};
        var currentSymbol = "{sel}";
        var currentTf = "{tf}";
        var currentExt = {ext_flag};
        var missingSymbol = "{missing_symbol}";
        var missingMessage = "{missing_message}";
        var watchlistMessage = "{watchlist_message}";
        var currentSearch = {search_query_js};
        var lastSearchQuery = currentSearch || "";
        var symbolUniverse = {symbol_universe_json};
        var serverWatchlist = {watchlist_json};
        if (!symbolData[currentSymbol]) {{
            var keys = Object.keys(symbolData);
            currentSymbol = keys.length ? keys[0] : "";
        }}
        var cData = currentSymbol && symbolData[currentSymbol]
            ? symbolData[currentSymbol].candles
            : [];
        var upColor = '{UP}';
        var downColor = '{DOWN}';

        var WATCHLIST_KEY = 'fv_watchlist';

        function readLocalWatchlistState() {{
            var raw = null;
            try {{ raw = localStorage.getItem(WATCHLIST_KEY); }} catch (e) {{}}
            if (raw === null) return {{ list: null, hasValue: false }};
            try {{
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {{
                    return {{ list: parsed, hasValue: true }};
                }}
                return {{ list: null, hasValue: false }};
            }} catch (e) {{
                return {{ list: null, hasValue: false }};
            }}
        }}

        function writeLocalWatchlist(list) {{
            try {{ localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list || [])); }} catch (e) {{}}
        }}

        function readLocalSelected() {{
            try {{ return localStorage.getItem('selectedSymbol') || ''; }} catch (e) {{ return ''; }}
        }}

        function listsEqual(a, b) {{
            if (!Array.isArray(a) || !Array.isArray(b)) return false;
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {{
                if (a[i] !== b[i]) return false;
            }}
            return true;
        }}

        function sendEvent(payload) {{
            if (!payload) return;
            payload.stamp = Date.now();
            try {{
                console.log("WATCHLIST_EVENT", payload);
            }} catch (e) {{}}
            try {{
                window.parent.postMessage({{
                    isStreamlitMessage: true,
                    type: "streamlit:setComponentValue",
                    value: payload
                }}, "*");
            }} catch (e) {{}}
        }}

        function syncFromLocalStorage() {{
            var state = readLocalWatchlistState();
            if (!state.hasValue) {{
                writeLocalWatchlist(serverWatchlist || []);
                return;
            }}
            var localList = state.list || [];
            var localSel = readLocalSelected();
            if (localSel && localList.indexOf(localSel) === -1) {{
                localSel = '';
            }}
            if (!listsEqual(localList, serverWatchlist) || (localSel && localSel !== currentSymbol)) {{
                sendEvent({{ type: 'init', watchlist: localList, selected: localSel }});
            }}
        }}

        function showFatal(message) {{
            var banner = document.getElementById('fv-fatal-banner');
            if (!banner) return;
            banner.textContent = message;
            banner.style.display = 'block';
        }}

        if (!window._fvErrorHandlersBound) {{
            window.addEventListener('error', function(e) {{
                var msg = e && e.message ? e.message : 'Unknown script error';
                showFatal('JS error: ' + msg);
            }});

            window.addEventListener('unhandledrejection', function(e) {{
                var reason = e && e.reason ? e.reason : 'Unknown rejection';
                var msg = reason && reason.message ? reason.message : String(reason);
                showFatal('Unhandled promise: ' + msg);
            }});
            window._fvErrorHandlersBound = true;
        }}

        var missingDeps = [];
        if (!window.LightweightCharts) missingDeps.push('LightweightCharts');
        if (!window.Split) missingDeps.push('Split');
        if (!window.Sortable) missingDeps.push('Sortable');
        if (missingDeps.length) {{
            showFatal('Missing dependency: ' + missingDeps.join(', ') + '. Check CDN availability.');
        }}

        // Keepalive ping to avoid idle Wi-Fi drops on some networks
        (function() {{
            var keepaliveUrl = window.location.origin + '/_stcore/health';
            setInterval(function() {{
                fetch(keepaliveUrl, {{ cache: 'no-store' }}).catch(function(){{}});
            }}, 15000);
        }})();

        // Split.js - Resizable Panels
        var splitInstance = null;
        if (window._fvSplitInstance && window._fvSplitInstance.destroy) {{
            try {{ window._fvSplitInstance.destroy(); }} catch (e) {{}}
        }}
        if (window.Split) {{
            splitInstance = Split(['#chart-panel', '#watchlist-panel'], {{
                sizes: [75, 25],
                minSize: [400, 200],
                gutterSize: 8,
                cursor: 'col-resize',
                onDragEnd: function(sizes) {{
                    localStorage.setItem('panelSizes', JSON.stringify(sizes));
                }}
            }});
            window._fvSplitInstance = splitInstance;
        }}

        // Restore panel sizes
        var panelSizesRaw = null;
        try {{ panelSizesRaw = localStorage.getItem('panelSizes'); }} catch (e) {{}}
        if (panelSizesRaw && splitInstance) {{
             try {{ splitInstance.setSizes(JSON.parse(panelSizesRaw)); }} catch(e) {{}}
        }}

        // SortableJS - Draggable Watchlist
        var wlC = document.getElementById('watchlist-items');
        if (window._fvSortableInstance && window._fvSortableInstance.destroy) {{
            try {{ window._fvSortableInstance.destroy(); }} catch (e) {{}}
        }}
        if (window.Sortable && wlC) {{
            window._fvSortableInstance = new Sortable(wlC, {{
                animation: 150,
                handle: '.drag-handle', // Only drag via the handle
                ghostClass: 'dragging',
                onEnd: function(evt) {{
                    const items = document.querySelectorAll('.watch-item');
                    const order = Array.from(items).map(item => item.dataset.symbol);
                    localStorage.setItem('watchlistOrder', JSON.stringify(order));
                }}
            }});
        }}

        // Restore watchlist order
        var watchlistOrderRaw = null;
        try {{ watchlistOrderRaw = localStorage.getItem('watchlistOrder'); }} catch (e) {{}}
        if (watchlistOrderRaw) {{
            try {{
                var order = JSON.parse(watchlistOrderRaw);
                var rows = Array.from(wlC.children);
                var rm = {{}}; rows.forEach(function(r){{rm[r.dataset.symbol] = r}});
                order.forEach(function(tk){{if(rm[tk]) wlC.appendChild(rm[tk])}});
                // Append any new ones not in saved order
                rows.forEach(function(r){{if(!order.includes(r.dataset.symbol)) wlC.appendChild(r)}});
            }} catch(e) {{}}
        }}

        // Initialize Chart (TradingView Lightweight)
        var chart = {{
            applyOptions: function() {{}},
            timeScale: function() {{ return {{ fitContent: function() {{}} }}; }},
            subscribeCrosshairMove: function() {{}}
        }};
        var series = {{ setData: function() {{}} }};
        var smaSeries = {{ setData: function() {{}}, applyOptions: function() {{}} }};
        var emaSeries = {{ setData: function() {{}}, applyOptions: function() {{}} }};
        if (window._fvChart && window._fvChart.remove) {{
            try {{ window._fvChart.remove(); }} catch (e) {{}}
        }}
        if (window.LightweightCharts) {{
            chart = LightweightCharts.createChart(document.getElementById('chart-container'), {{
                layout: {{
                    background: {{ color: '{BG}' }},
                    textColor: '{DIM}',
                }},
                grid: {{
                    vertLines: {{ color: '#15211c' }},
                    horzLines: {{ color: '#15211c' }},
                }},
                rightPriceScale: {{
                    borderColor: '{BORDER}',
                }},
                timeScale: {{
                    borderColor: '{BORDER}',
                    timeVisible: true,
                }},
                crosshair: {{
                    vertLine: {{ color: '{DIM}', style: 2 }},
                    horzLine: {{ color: '{DIM}', style: 2 }},
                }},
            }});

            series = chart.addCandlestickSeries({{
                upColor: upColor,
                downColor: downColor,
                borderUpColor: upColor,
                borderDownColor: downColor,
            }});
            smaSeries = chart.addLineSeries({{
                color: '{BLUE}',
                lineWidth: 1,
                priceLineVisible: false,
            }});
            emaSeries = chart.addLineSeries({{
                color: '#ffb454',
                lineWidth: 1,
                priceLineVisible: false,
            }});
            window._fvChart = chart;
        }}

        // Handle window resize
        if (window._fvResizeHandler) {{
            try {{ window.removeEventListener('resize', window._fvResizeHandler); }} catch (e) {{}}
        }}
        window._fvResizeHandler = function() {{
            chart.applyOptions({{
                width: document.getElementById('chart-container').clientWidth,
                height: document.getElementById('chart-container').clientHeight,
            }});
        }};
        window.addEventListener('resize', window._fvResizeHandler);
        
        // Crosshair + header updates
        var vO=document.getElementById('vO'),vH=document.getElementById('vH'),
            vL=document.getElementById('vL'),vC=document.getElementById('vC'),
            vS=document.getElementById('vS'),vBigP=document.getElementById('vBigP');
        var symbolNameEl = document.getElementById('symbolName');
        var symbolMetaEl = document.getElementById('symbolMeta');
        var priceChangeEl = document.getElementById('priceChange');
        var qpSymbol = document.getElementById('qpSymbol');
        var qpStatus = document.getElementById('qpStatus');
        var qpPrice = document.getElementById('qpPrice');
        var qpChange = document.getElementById('qpChange');
        var qpOpen = document.getElementById('qpOpen');
        var qpHigh = document.getElementById('qpHigh');
        var qpLow = document.getElementById('qpLow');
        var qpVol = document.getElementById('qpVol');
        var qpTime = document.getElementById('qpTime');
        var qpEma = document.getElementById('qpEma');
        var toggleSMA = document.getElementById('toggleSMA');
        var toggleEMA = document.getElementById('toggleEMA');
        
        var fmt=function(n){{
            if(n==null || Number.isNaN(n)) return '--';
            return n.toLocaleString('en-US',{{minimumFractionDigits:2,maximumFractionDigits:2}});
        }};
        var fmtVol=function(n){{
            if(n==null || Number.isNaN(n)) return '--';
            if(n >= 1e9) return (n/1e9).toFixed(2) + 'B';
            if(n >= 1e6) return (n/1e6).toFixed(2) + 'M';
            if(n >= 1e3) return (n/1e3).toFixed(2) + 'K';
            return n.toFixed(0);
        }};

        function updateOHLC(o,h,l,cl,sm){{
            vO.textContent=fmt(o);vH.textContent=fmt(h);
            vL.textContent=fmt(l);vC.textContent=fmt(cl);
            var c=(cl!=null && o!=null && cl>=o)?upColor:downColor;
            vO.style.color=c;vH.style.color=c;vL.style.color=c;vC.style.color=c;
            vBigP.textContent=fmt(cl);vBigP.style.color=c;
            if(sm !== undefined) {{
                vS.textContent=sm!=null?fmt(sm):'--';
            }}
        }}

        function updateIndicators(symbol){{
            var sd = symbolData[symbol];
            if(!sd) return;
            smaSeries.setData(sd.sma20 || []);
            emaSeries.setData(sd.ema50 || []);
        }}

        function updateQuotePanel(symbol){{
            var sd = symbolData[symbol];
            if(!sd || !sd.panel) return;
            if(qpSymbol) qpSymbol.textContent = symbol;
            if(qpStatus) {{
                qpStatus.textContent = sd.panel.status || '';
                qpStatus.style.color = sd.panel.status === 'EXT' ? '#ffb454' : '{ACCENT}';
            }}
            if(qpPrice) {{
                qpPrice.textContent = fmt(sd.last.c);
                qpPrice.style.color = sd.price_color;
            }}
            if(qpChange) {{
                qpChange.textContent = sd.chg_str + ' (' + sd.chg_pct_str + ')';
                qpChange.style.color = sd.price_color;
            }}
            if(qpOpen) qpOpen.textContent = fmt(sd.panel.open);
            if(qpHigh) qpHigh.textContent = fmt(sd.panel.high);
            if(qpLow) qpLow.textContent = fmt(sd.panel.low);
            if(qpVol) qpVol.textContent = fmtVol(sd.panel.volume);
            if(qpTime) qpTime.textContent = sd.panel.time_str || '--';
            if(qpEma) qpEma.textContent = sd.last.e != null ? fmt(sd.last.e) : '--';
        }}

        function applyIndicatorState(){{
            var showSMA = toggleSMA ? toggleSMA.checked : false;
            var showEMA = toggleEMA ? toggleEMA.checked : false;
            smaSeries.applyOptions({{ visible: !!showSMA }});
            emaSeries.applyOptions({{ visible: !!showEMA }});
            try {{
                localStorage.setItem('indicatorState', JSON.stringify({{ sma: !!showSMA, ema: !!showEMA }}));
            }} catch(e) {{}}
        }}

        function updateWarning(){{
            var warn = document.getElementById('dataWarning');
            if (!warn) return;
            if (watchlistMessage) {{
                warn.textContent = watchlistMessage;
                warn.style.display = 'block';
            }} else if (missingSymbol) {{
                warn.textContent = missingMessage || ("No data for " + missingSymbol);
                warn.style.display = 'block';
            }} else {{
                warn.textContent = '';
                warn.style.display = 'none';
            }}
        }}

        function normalizeSymbol(val){{
            if (!val) return "";
            return val.trim().toUpperCase().replace(/[^A-Z0-9=\-.\^/]/g, "");
        }}

        function filterWatchlist(){{
            var input = document.getElementById('watchSearch');
            if (!input) return;
            var q = normalizeSymbol(input.value);
            var rows = document.querySelectorAll('.watch-item');
            rows.forEach(function(r){{
                var sym = (r.dataset.symbol || "").toUpperCase();
                var name = (r.dataset.name || "").toUpperCase();
                var match = !q || sym.indexOf(q) >= 0 || name.indexOf(q) >= 0;
                r.style.display = match ? '' : 'none';
            }});
        }}

        var searchTimer = null;

        function escapeHtml(str) {{
            return String(str || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }}

        function renderSearchResults(items, query, errorMsg){{
            var el = document.getElementById('searchResults');
            if (!el) return;
            if (!query || query.length < 2) {{
                el.classList.remove('active');
                el.innerHTML = '';
                return;
            }}
            el.classList.add('active');
            if (errorMsg) {{
                el.innerHTML = '<div class="search-empty">' + escapeHtml(errorMsg) + '</div>';
                return;
            }}
            if (!items || !items.length) {{
                el.innerHTML = '<div class="search-empty">No matches. Use + to add exact ticker.</div>';
                return;
            }}
            var html = items.map(function(item){{
                var sym = escapeHtml(item.symbol || '');
                var name = escapeHtml(item.name || '');
                var meta = escapeHtml(item.meta || '');
                return '<div class="search-item" data-symbol="' + sym + '">' +
                    '<div class="search-main">' +
                        '<div class="search-symbol">' + sym + '</div>' +
                        '<div class="search-name">' + name + '</div>' +
                    '</div>' +
                    '<div class="search-meta">' + meta + '</div>' +
                '</div>';
            }}).join('');
            el.innerHTML = html;
        }}

        function performLiveSearch(query){{
            var qRaw = String(query || '').trim().toUpperCase();
            var qSym = normalizeSymbol(query);
            try {{
                console.log("WATCHLIST_EVENT", {{ type: 'search', query: qRaw }});
            }} catch (e) {{}}
            if (!qRaw || qRaw.length < 2) {{
                lastSearchQuery = qRaw;
                renderSearchResults([], qRaw, '');
                return;
            }}
            if (qRaw === lastSearchQuery) {{
                return;
            }}
            lastSearchQuery = qRaw;
            var items = [];
            for (var i = 0; i < symbolUniverse.length; i++) {{
                var item = symbolUniverse[i] || {{}};
                var sym = (item.symbol || '').toUpperCase();
                if (!sym) continue;
                var name = (item.name || '').toUpperCase();
                if ((qSym && sym.indexOf(qSym) === 0) || (name && name.indexOf(qRaw) >= 0)) {{
                    var meta = [item.exchange || '', item.type || ''].filter(Boolean).join(' · ');
                    items.push({{ symbol: sym, name: item.name || '', meta: meta }});
                    if (items.length >= 12) break;
                }}
            }}
            renderSearchResults(items, qRaw, '');
        }}

        function debouncedSearch(){{
            if (searchTimer) {{
                clearTimeout(searchTimer);
            }}
            searchTimer = setTimeout(function() {{
                var input = document.getElementById('watchSearch');
                if (!input) return;
                performLiveSearch(input.value || '');
            }}, 350);
        }}

        function getWorkingWatchlist(){{
            var state = readLocalWatchlistState();
            if (state.hasValue && Array.isArray(state.list)) {{
                return state.list.slice();
            }}
            return (serverWatchlist || []).slice();
        }}

        function addSymbolToWatchlist(sym){{
            var list = getWorkingWatchlist();
            if (!list.includes(sym)) {{
                list.push(sym);
            }}
            writeLocalWatchlist(list);
            try {{ localStorage.setItem('selectedSymbol', sym); }} catch (e) {{}}
            sendEvent({{ type: 'add', symbol: sym, watchlist: list, selected: sym }});
        }}

        function addSymbolFromInput(){{
            var input = document.getElementById('watchSearch');
            if (!input) return;
            var sym = normalizeSymbol(input.value);
            if (!sym) return;
            var list = getWorkingWatchlist();
            if (list.includes(sym)) {{
                switchSymbol(null, sym);
                return;
            }}
            addSymbolToWatchlist(sym);
        }}

        function addTopSearchResult(){{
            var first = document.querySelector('#searchResults .search-item');
            if (first && first.dataset && first.dataset.symbol) {{
                addSymbolToWatchlist(first.dataset.symbol);
                return;
            }}
            addSymbolFromInput();
        }}

        function removeSymbol(evt, symbol){{
            if (evt) evt.stopPropagation();
            var list = getWorkingWatchlist().filter(function(item) {{
                return item !== symbol;
            }});
            var nextSelected = currentSymbol;
            if (symbol === currentSymbol) {{
                nextSelected = list.length ? list[0] : '';
            }}
            writeLocalWatchlist(list);
            if (nextSelected) {{
                try {{ localStorage.setItem('selectedSymbol', nextSelected); }} catch (e) {{}}
            }} else {{
                try {{ localStorage.removeItem('selectedSymbol'); }} catch (e) {{}}
            }}
            sendEvent({{ type: 'remove', symbol: symbol, watchlist: list, selected: nextSelected }});
        }}

        function updateViewControls(){{
            var tfButtons = document.querySelectorAll('.tf-btn');
            tfButtons.forEach(function(btn){{
                btn.classList.toggle('active', btn.dataset.tf === currentTf);
            }});
            var extToggle = document.getElementById('extToggle');
            if (extToggle) {{
                extToggle.classList.toggle('active', !!currentExt);
            }}
        }}

        function updateActive(symbol){{
            var rows = document.querySelectorAll('.watch-item');
            rows.forEach(function(r){{
                if(r.dataset.symbol === symbol) r.classList.add('active');
                else r.classList.remove('active');
            }});
        }}

        function updateHeaderForSymbol(symbol){{
            var sd = symbolData[symbol];
            if(!sd) return;
            if(symbolNameEl) symbolNameEl.textContent = symbol;
            if(symbolMetaEl) symbolMetaEl.textContent = sd.meta_text || '';
            if(priceChangeEl) {{
                priceChangeEl.textContent = sd.chg_str + ' (' + sd.chg_pct_str + ')';
                priceChangeEl.style.color = sd.price_color;
            }}
            updateOHLC(sd.last.o, sd.last.h, sd.last.l, sd.last.c, sd.last.s);
            vBigP.style.color = sd.price_color;
            updateQuotePanel(symbol);
        }}

        function switchSymbol(evt, symbol){{
            var clickEvent = evt || window.event;
            if (clickEvent && clickEvent.target && clickEvent.target.closest('.drag-handle')) return;
            if(!symbolData[symbol]) {{
                sendEvent({{ type: 'select', symbol: symbol, watchlist: getWorkingWatchlist(), selected: symbol }});
                return;
            }}
            currentSymbol = symbol;
            cData = symbolData[symbol].candles || [];
            series.setData(cData);
            updateIndicators(symbol);
            applyIndicatorState();
            chart.timeScale().fitContent();
            updateHeaderForSymbol(symbol);
            updateActive(symbol);
            try {{ localStorage.setItem('selectedSymbol', symbol); }} catch(e) {{}}
        }}

        var savedSymbol = null;
        try {{ savedSymbol = localStorage.getItem('selectedSymbol'); }} catch(e) {{}}
        var initialSymbol = (savedSymbol && symbolData[savedSymbol]) ? savedSymbol : currentSymbol;
        var indicatorState = null;
        try {{ indicatorState = JSON.parse(localStorage.getItem('indicatorState')); }} catch(e) {{}}
        if(indicatorState) {{
            if(toggleSMA) toggleSMA.checked = !!indicatorState.sma;
            if(toggleEMA) toggleEMA.checked = !!indicatorState.ema;
        }}
        if(toggleSMA) toggleSMA.addEventListener('change', applyIndicatorState);
        if(toggleEMA) toggleEMA.addEventListener('change', applyIndicatorState);
        var searchInput = document.getElementById('watchSearch');
        if (searchInput) {{
            searchInput.addEventListener('input', function(){{
                debouncedSearch();
            }});
            searchInput.addEventListener('keydown', function(e){{
                if (e.key === 'Enter') {{
                    addTopSearchResult();
                }}
            }});
        }}
        var searchBtn = document.getElementById('watchSearchBtn');
        if (searchBtn) {{
            searchBtn.addEventListener('click', function(){{
                addTopSearchResult();
            }});
        }}
        var addBtn = document.getElementById('watchAddBtn');
        if (addBtn) {{
            addBtn.addEventListener('click', function(){{
                addSymbolFromInput();
            }});
        }}
        var searchResultsEl = document.getElementById('searchResults');
        if (searchResultsEl) {{
            searchResultsEl.addEventListener('click', function(e){{
                var item = e.target.closest('.search-item');
                if (!item) return;
                var sym = item.dataset.symbol;
                if (sym) {{
                    addSymbolToWatchlist(sym);
                }}
            }});
        }}
        var symbolToggle = document.getElementById('symbolToggle');
        var symbolMenu = document.getElementById('symbolMenu');
        var symbolMenuSearch = document.getElementById('symbolMenuSearch');
        function closeSymbolMenu(){{
            if (symbolMenu) symbolMenu.classList.remove('active');
        }}
        function toggleSymbolMenu(){{
            if (!symbolMenu) return;
            symbolMenu.classList.toggle('active');
            if (symbolMenu.classList.contains('active') && symbolMenuSearch) {{
                symbolMenuSearch.focus();
            }}
        }}
        if (symbolToggle) {{
            symbolToggle.addEventListener('click', function(e){{
                e.stopPropagation();
                toggleSymbolMenu();
            }});
        }}
        if (symbolMenuSearch) {{
            symbolMenuSearch.addEventListener('input', function(){{
                var q = normalizeSymbol(symbolMenuSearch.value);
                document.querySelectorAll('.symbol-menu-item').forEach(function(item){{
                    var sym = (item.dataset.symbol || "").toUpperCase();
                    var name = (item.dataset.name || "").toUpperCase();
                    var match = !q || sym.indexOf(q) >= 0 || name.indexOf(q) >= 0;
                    item.style.display = match ? '' : 'none';
                }});
            }});
        }}
        document.querySelectorAll('.symbol-menu-item').forEach(function(item){{
            item.addEventListener('click', function(){{
                var sym = item.dataset.symbol;
                if (sym) {{
                    switchSymbol(null, sym);
                    closeSymbolMenu();
                }}
            }});
        }});
        if (window._fvDocClickHandler) {{
            try {{ document.removeEventListener('click', window._fvDocClickHandler); }} catch (e) {{}}
        }}
        window._fvDocClickHandler = function(e) {{
            if (!symbolMenu || !symbolMenu.classList.contains('active')) return;
            if (symbolMenu.contains(e.target)) return;
            if (symbolToggle && symbolToggle.contains(e.target)) return;
            closeSymbolMenu();
        }};
        document.addEventListener('click', window._fvDocClickHandler);
        document.querySelectorAll('.tf-btn').forEach(function(btn){{
            btn.addEventListener('click', function(){{
                var tf = btn.dataset.tf;
                if (tf && tf !== currentTf) {{
                    sendEvent({{ type: 'timeframe', timeframe: tf, watchlist: getWorkingWatchlist(), selected: currentSymbol }});
                }}
            }});
        }});
        var extToggleEl = document.getElementById('extToggle');
        if (extToggleEl) {{
            extToggleEl.addEventListener('click', function(){{
                var nextExt = !currentExt;
                sendEvent({{ type: 'ext', extended: nextExt, watchlist: getWorkingWatchlist(), selected: currentSymbol }});
            }});
        }}
        sendEvent({{ type: 'ready', status: 'ready' }});
        syncFromLocalStorage();
        updateViewControls();
        updateWarning();
        if(initialSymbol) {{
            switchSymbol(null, initialSymbol);
        }}
        if (currentSearch && currentSearch.length >= 2) {{
            performLiveSearch(currentSearch);
        }}

        chart.subscribeCrosshairMove(function(p){{
            if(!p||!p.time){{
                // Reset to last candle
                if(cData.length > 0) {{
                   var l = cData[cData.length - 1];
                   updateOHLC(l.open, l.high, l.low, l.close);
                }}
                return;
            }}
            var cd=p.seriesData.get(series);
            if(cd) updateOHLC(cd.open,cd.high,cd.low,cd.close);
        }});
    </script>
</body>
</html>"""

# ══════════════════════════════════════════════════════════════════════════════
_component_frontend = Path(__file__).parent / "fadingview_component" / "frontend"
_build_dir = _component_frontend / "build"
_dist_dir = _component_frontend / "dist"
if (_build_dir / "index.html").exists():
    _component_path = _build_dir
elif (_dist_dir / "index.html").exists():
    _component_path = _dist_dir
else:
    raise RuntimeError(
        "Component not built. Run npm run build in fadingview_component/frontend."
    )

component_func = components.declare_component(
    "fadingview",
    path=str(_component_path),
)

if "watchlist" not in st.session_state:
    st.session_state.watchlist = ["SPY", "QQQ", "AAPL"]
if "selected_symbol" not in st.session_state:
    st.session_state.selected_symbol = "SPY"
if "chart_data" not in st.session_state:
    st.session_state.chart_data = {}

component_event = component_func(
    watchlist=st.session_state.watchlist,
    selected=st.session_state.selected_symbol,
    chart_data=st.session_state.chart_data.get(st.session_state.selected_symbol, []),
    key="fv_main",
    height=800,
)

if component_event:
    needs_rerun = handle_component_event(component_event)
    if needs_rerun:
        st.rerun()
