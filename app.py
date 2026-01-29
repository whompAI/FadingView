import streamlit as st
import streamlit.components.v1 as components
import yfinance as yf
import pandas as pd
import requests
import hashlib
import json
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

# ── State ────────────────────────────────────────────────────────────────────
for k, v in {
    "watchlist": ["NQ=F","ES=F","SPY","QQQ","BTC-USD","NVDA","GOOG",
                  "META","PLTR","INTC","AMD","MU","AMZN","AAPL","AVGO"],
    "selected": "AVGO", "timeframe": "15m", "extended": False,
}.items():
    if k not in st.session_state:
        st.session_state[k] = v

TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"]

# ── Handle query params (symbol/timeframe/extended) ──────────────────────────
def _parse_bool(val):
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "t", "yes", "y", "on")
    return bool(val)

qp = st.query_params
requested_symbol = None
if "sel" in qp:
    _s = qp["sel"]
    requested_symbol = _s
    if _s in st.session_state.watchlist:
        st.session_state.selected = _s
if "tf" in qp:
    _tf = qp["tf"]
    if _tf in TIMEFRAMES:
        st.session_state.timeframe = _tf
if "ext" in qp:
    st.session_state.extended = _parse_bool(qp["ext"])

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
    sparklines = data["sparklines"]
    ticker_names = data["ticker_names"]
    last = data["last"]
    ext_flag = "true" if data.get("is_ext") else "false"
    data_status = data.get("data_status", {})
    missing_symbol = data.get("missing_symbol") or ""
    missing_message = data.get("missing_message") or ""
    
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
            <div class="watch-item{active_cls}{no_data_cls}" data-symbol="{tk}" onclick="switchSymbol(event, '{tk}')">
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
            </div>
            """
        else:
            wl_rows += f"""
            <div class="watch-item{active_cls}{no_data_cls}" data-symbol="{tk}" onclick="switchSymbol(event, '{tk}')">
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
        }}

        .header-left {{
            display: flex;
            align-items: center;
            gap: 12px;
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
        }}

        .symbol-name {{
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary);
            letter-spacing: 0.2px;
            display: flex;
            align-items: center;
            gap: 6px;
        }}

        .symbol-meta {{
            font-size: 9px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1.2px;
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
                <div class="symbol-name">
                    <span id="symbolName">{sel}</span>
                    <span style="font-size: 10px; color: var(--text-secondary);">▼</span>
                </div>
                <div class="symbol-meta" id="symbolMeta">{meta_text}</div>
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
        var symbolData = {symbol_data_json};
        var currentSymbol = "{sel}";
        var currentTf = "{tf}";
        var currentExt = {ext_flag};
        var missingSymbol = "{missing_symbol}";
        var missingMessage = "{missing_message}";
        if (!symbolData[currentSymbol]) {{
            var keys = Object.keys(symbolData);
            currentSymbol = keys.length ? keys[0] : "";
        }}
        var cData = currentSymbol && symbolData[currentSymbol]
            ? symbolData[currentSymbol].candles
            : [];
        var upColor = '{UP}';
        var downColor = '{DOWN}';

        function setParentParam(key, value, reload) {{
            try {{
                var parentUrl = new URL(window.parent.location.href);
                if (value === null || value === undefined) {{
                    parentUrl.searchParams.delete(key);
                }} else {{
                    parentUrl.searchParams.set(key, value);
                }}
                if (reload) {{
                    window.parent.location.href = parentUrl.toString();
                }} else {{
                    window.parent.history.replaceState({{}}, "", parentUrl.toString());
                }}
            }} catch (e) {{
                try {{
                    var localUrl = new URL(window.location.href);
                    if (value === null || value === undefined) {{
                        localUrl.searchParams.delete(key);
                    }} else {{
                        localUrl.searchParams.set(key, value);
                    }}
                    if (reload) {{
                        window.location.href = localUrl.toString();
                    }} else {{
                        window.history.replaceState({{}}, "", localUrl.toString());
                    }}
                }} catch (err) {{}}
            }}
        }}

        // Split.js - Resizable Panels
        Split(['#chart-panel', '#watchlist-panel'], {{
            sizes: [75, 25],
            minSize: [400, 200],
            gutterSize: 8,
            cursor: 'col-resize',
            onDragEnd: function(sizes) {{
                localStorage.setItem('panelSizes', JSON.stringify(sizes));
            }}
        }});

        // Restore panel sizes
        const savedSizes = localStorage.getItem('panelSizes');
        if (savedSizes) {{
             try {{ Split(['#chart-panel', '#watchlist-panel']).setSizes(JSON.parse(savedSizes)); }} catch(e) {{}}
        }}

        // SortableJS - Draggable Watchlist
        var wlC = document.getElementById('watchlist-items');
        new Sortable(wlC, {{
            animation: 150,
            handle: '.drag-handle', // Only drag via the handle
            ghostClass: 'dragging',
            onEnd: function(evt) {{
                const items = document.querySelectorAll('.watch-item');
                const order = Array.from(items).map(item => item.dataset.symbol);
                localStorage.setItem('watchlistOrder', JSON.stringify(order));
            }}
        }});

        // Restore watchlist order
        const savedOrder = localStorage.getItem('watchlistOrder');
        if (savedOrder) {{
            try {{
                var order = JSON.parse(savedOrder);
                var rows = Array.from(wlC.children);
                var rm = {{}}; rows.forEach(function(r){{rm[r.dataset.symbol] = r}});
                order.forEach(function(tk){{if(rm[tk]) wlC.appendChild(rm[tk])}});
                // Append any new ones not in saved order
                rows.forEach(function(r){{if(!order.includes(r.dataset.symbol)) wlC.appendChild(r)}});
            }} catch(e) {{}}
        }}

        // Initialize Chart (TradingView Lightweight)
        const chart = LightweightCharts.createChart(document.getElementById('chart-container'), {{
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

        const series = chart.addCandlestickSeries({{
            upColor: upColor,
            downColor: downColor,
            borderUpColor: upColor,
            borderDownColor: downColor,
        }});
        const smaSeries = chart.addLineSeries({{
            color: '{BLUE}',
            lineWidth: 1,
            priceLineVisible: false,
        }});
        const emaSeries = chart.addLineSeries({{
            color: '#ffb454',
            lineWidth: 1,
            priceLineVisible: false,
        }});

        // Handle window resize
        window.addEventListener('resize', () => {{
            chart.applyOptions({{
                width: document.getElementById('chart-container').clientWidth,
                height: document.getElementById('chart-container').clientHeight,
            }});
        }});
        
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
            if (missingSymbol) {{
                warn.textContent = missingMessage || ("No data for " + missingSymbol);
                warn.style.display = 'block';
            }} else {{
                warn.textContent = '';
                warn.style.display = 'none';
            }}
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
                setParentParam('sel', symbol, true);
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
            setParentParam('sel', symbol, false);
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
        document.querySelectorAll('.tf-btn').forEach(function(btn){{
            btn.addEventListener('click', function(){{
                var tf = btn.dataset.tf;
                if (tf && tf !== currentTf) {{
                    setParentParam('tf', tf, true);
                }}
            }});
        }});
        var extToggleEl = document.getElementById('extToggle');
        if (extToggleEl) {{
            extToggleEl.addEventListener('click', function(){{
                var nextExt = currentExt ? "0" : "1";
                setParentParam('ext', nextExt, true);
            }});
        }}
        updateViewControls();
        updateWarning();
        if(initialSymbol) {{
            switchSymbol(null, initialSymbol);
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
sel = st.session_state.selected
tf  = st.session_state.timeframe
ext = st.session_state.extended
wl  = st.session_state.watchlist
quotes = get_all_quotes(tuple(wl))

# ── DATA ASSEMBLY & RENDER ───────────────────────────────────────────────────
if not sel:
    st.info("Add a symbol to get started."); st.stop()

def _fmt_last(v):
    return f"{v:,.2f}" if v is not None else "--"

def _fmt_vol(v):
    if v is None:
        return "--"
    if v >= 1e9:
        return f"{v/1e9:.2f}B"
    if v >= 1e6:
        return f"{v/1e6:.2f}M"
    if v >= 1e3:
        return f"{v/1e3:.2f}K"
    return f"{v:.0f}"

# Gather ticker info
ticker_info = {}
for tk in wl:
    n, ex_name, _ = get_info(tk)
    ticker_info[tk] = {"name": n, "exchange": ex_name}

symbol_data = {}
for tk in wl:
    df_t = fetch_ohlcv(tk, tf, ext)
    effective_tf = tf
    effective_ext = ext
    if df_t.empty and tf not in ("1D", "1W"):
        df_t = fetch_ohlcv(tk, "1D", False)
        effective_tf = "1D"
        effective_ext = False
    if df_t.empty:
        continue
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
    ex_name = ticker_info.get(tk, {}).get("exchange", "")
    session_tag = "RTH" if effective_tf in ("1D", "1W") else ("EXT" if effective_ext else "RTH")
    meta_text = f"{ex_name} · {effective_tf.upper()} · {session_tag}" if ex_name else f"{effective_tf.upper()} · {session_tag}"

    symbol_data[tk] = {
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

if not symbol_data:
    st.error(f"No data for watchlist symbols on {tf}."); st.stop()

missing_symbol = None
if sel not in symbol_data:
    missing_symbol = sel
    sel = next(iter(symbol_data.keys()))
    st.session_state.selected = sel

selected_data = symbol_data[sel]
missing_message = f"No data for {missing_symbol}" if missing_symbol else ""
data_status = {tk: tk in symbol_data for tk in wl}
panel_fmt = {
    "status": selected_data["panel"]["status"],
    "open": _fmt_last(selected_data["panel"]["open"]),
    "high": _fmt_last(selected_data["panel"]["high"]),
    "low": _fmt_last(selected_data["panel"]["low"]),
    "volume": _fmt_vol(selected_data["panel"]["volume"]),
    "time_str": selected_data["panel"]["time_str"] or "--",
    "ema": _fmt_last(selected_data["last"]["e"]),
}

sparklines = get_sparklines(tuple(wl))
ticker_names = {tk: info["name"] for tk, info in ticker_info.items()}

component_data = {
    "selected": sel,
    "timeframe": tf,
    "is_ext": ext,
    "watchlist": wl,
    "quotes": quotes,
    "sparklines": sparklines,
    "ticker_names": ticker_names,
    "data_status": data_status,
    "missing_symbol": missing_symbol,
    "missing_message": missing_message,
    "symbol_data": symbol_data,
    "meta_text": selected_data["meta_text"],
    "last": {
        "o": _fmt_last(selected_data["last"]["o"]),
        "h": _fmt_last(selected_data["last"]["h"]),
        "l": _fmt_last(selected_data["last"]["l"]),
        "c": _fmt_last(selected_data["last"]["c"]),
        "s": _fmt_last(selected_data["last"]["s"]),
    },
    "price_color": selected_data["price_color"],
    "chg_str": selected_data["chg_str"],
    "chg_pct_str": selected_data["chg_pct_str"],
    "panel_fmt": panel_fmt,
}

# IMPORTANT: Increase height to allow full view as body is 100vh
components.html(build_html_component(component_data), height=950, scrolling=False)
