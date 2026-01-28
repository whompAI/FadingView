import streamlit as st
import streamlit.components.v1 as components
import yfinance as yf
import pandas as pd
import requests
import hashlib
import json

st.set_page_config(layout="wide", page_title="Vibe Coder", initial_sidebar_state="collapsed")

# ── Palette ──────────────────────────────────────────────────────────────────
BG, PANEL, BORDER = "#131722", "#1e222d", "#2a2e39"
TXT, DIM          = "#d1d4dc", "#787b86"
CYAN, RED, BLUE   = "#26c6da", "#ef5350", "#2962FF"

# ── State ────────────────────────────────────────────────────────────────────
for k, v in {
    "watchlist": ["NQ=F","ES=F","SPY","QQQ","BTC-USD","NVDA","GOOG",
                  "META","PLTR","INTC","AMD","MU","AMZN","AAPL","AVGO"],
    "selected": "AVGO", "timeframe": "15m", "extended": False,
}.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ── CSS — single-page dashboard ─────────────────────────────────────────────
st.markdown(f"""<style>
html,body,[data-testid="stAppViewContainer"],[data-testid="stApp"]
  {{background:{BG}!important;color:{TXT};overflow:hidden}}
[data-testid="stHeader"],[data-testid="stToolbar"],
[data-testid="stDecoration"],[data-testid="stSidebarCollapsedControl"],
#MainMenu,footer,header {{display:none!important}}

section.main>.block-container
  {{max-height:100vh;overflow:hidden;padding:.5rem 1rem 0;max-width:100%}}
div[data-testid="stVerticalBlock"]>div{{gap:.2rem}}

input{{background:{BG}!important;color:{TXT}!important;
      border:1px solid {BORDER}!important;border-radius:4px;padding:4px 8px}}
[data-testid="baseButton-secondary"]{{
  background:{PANEL}!important;color:{TXT}!important;
  border:1px solid {BORDER}!important;border-radius:4px!important;
  padding:2px 6px!important;font-size:.82rem!important}}
[data-testid="baseButton-secondary"]:hover{{background:{BORDER}!important}}
[data-testid="baseButton-primary"]{{
  background:{BLUE}!important;color:#fff!important;
  border:none!important;border-radius:4px!important;
  padding:2px 6px!important;font-size:.82rem!important}}
[data-testid="stFormSubmitButton"] button{{
  background:{CYAN}!important;color:#fff!important;border:none!important;
  padding:4px 10px!important}}
[data-testid="stSelectbox"]>div>div{{background:{PANEL};border-color:{BORDER}}}
iframe{{border:none!important}}

/* watchlist table */
.wt{{width:100%;border-collapse:collapse;font-size:.8rem;
     font-family:-apple-system,BlinkMacSystemFont,sans-serif}}
.wt th{{text-align:right;color:{DIM};font-weight:400;font-size:.7rem;
        padding:4px 5px;border-bottom:1px solid {BORDER}}}
.wt th:first-child{{text-align:left}}
.wt td{{padding:5px;text-align:right;color:{TXT};font-weight:500;
        border-bottom:1px solid {BORDER};white-space:nowrap}}
.wt td:first-child{{text-align:left;font-weight:700}}
.wt tr:hover{{background:{BORDER}}}
.wt tr.a{{background:rgba(41,98,255,.12);border-left:2px solid {BLUE}}}
.d{{display:inline-block;width:8px;height:8px;border-radius:50%;
    margin-right:4px;vertical-align:middle}}

/* detail card */
.det{{background:{PANEL};border:1px solid {BORDER};border-radius:6px;
      padding:8px 10px;margin-top:6px}}
.det .n{{font-weight:700;font-size:.88rem}}
.det .m{{font-size:.72rem;color:{DIM};margin:2px 0 6px}}
.det .px{{font-size:1.3rem;font-weight:800}}
.det .ch{{font-size:.82rem;font-weight:600}}
.det .po{{margin-top:6px;padding-top:6px;border-top:1px solid {BORDER}}}
.pd{{display:inline-block;width:6px;height:6px;border-radius:50%;
     background:#1565c0;margin-right:4px;vertical-align:middle}}
</style>""", unsafe_allow_html=True)

# ── Data helpers ─────────────────────────────────────────────────────────────
PERIOD   = {"1m":"1d","5m":"5d","15m":"5d","1h":"1mo","4h":"60d","1D":"1y","1W":"5y"}
INTERVAL = {"1m":"1m","5m":"5m","15m":"15m","1h":"1h","4h":"1h","1D":"1d","1W":"1wk"}
TWIT_MAP = {"NQ=F":"QQQ","ES=F":"SPY","YM=F":"DIA","BTC-USD":"BTC.X",
            "GC=F":"GLD","CL=F":"USO","RTY=F":"IWM"}
PRESETS  = {
    "Futures": ["NQ=F","ES=F","YM=F","RTY=F","GC=F","CL=F"],
    "Tech":    ["AAPL","MSFT","GOOG","AMZN","META","NVDA","NFLX","TSLA"],
    "Crypto":  ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","ADA-USD"],
    "Semis":   ["NVDA","AMD","INTC","AVGO","MU","TSM","QCOM"],
    "Finance": ["JPM","GS","BAC","V","MA","BRK-B"],
    "ETFs":    ["SPY","QQQ","IWM","DIA","XLF","XLE","GLD"],
}

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

# ══════════════════════════════════════════════════════════════════════════════
#  LAYOUT: chart col (75%) │ watchlist col (25%)
# ══════════════════════════════════════════════════════════════════════════════
sel, tf, ext = st.session_state.selected, st.session_state.timeframe, st.session_state.extended
quotes = get_all_quotes(tuple(st.session_state.watchlist))
chart_col, wl_col = st.columns([3, 1], gap="small")

# ── CHART COLUMN ─────────────────────────────────────────────────────────────
with chart_col:
    if not sel:
        st.info("Add a symbol to get started."); st.stop()
    df = fetch_ohlcv(sel, tf, ext)
    if df.empty:
        st.error(f"No data for {sel} on {tf}."); st.stop()

    # timeframe row + extended toggle
    tf_c = st.columns([1]*7 + [2])  # 7 tf buttons + 1 toggle
    for i, t in enumerate(["1m","5m","15m","1h","4h","1D","1W"]):
        with tf_c[i]:
            if st.button(t, key=f"t{t}", type="primary" if t==tf else "secondary",
                         use_container_width=True):
                st.session_state.timeframe = t; st.rerun()
    with tf_c[7]:
        nv = st.toggle("Ext Hrs", value=ext, key="ext_tog")
        if nv != ext: st.session_state.extended = nv; st.rerun()

    # build series data for JS injection
    L = df.iloc[-1]; cl=float(L["Close"])
    pv=float(df["Close"].iloc[-2]) if len(df)>1 else cl
    nm,ex_name,_=get_info(sel)
    sv=float(L["SMA20"]) if pd.notna(L.get("SMA20")) else None

    cnd, sma_data, vol_data = [], [], []
    for ts, r in df.iterrows():
        t = int(ts.timestamp())
        cnd.append({"time":t,"open":round(float(r["Open"]),2),"high":round(float(r["High"]),2),
                     "low":round(float(r["Low"]),2),"close":round(float(r["Close"]),2)})
        if pd.notna(r.get("SMA20")):
            sma_data.append({"time":t,"value":round(float(r["SMA20"]),2)})
        vol_data.append({"time":t,"value":float(r["Volume"]),
                     "color":"rgba(38,198,218,.35)" if r["Close"]>=r["Open"] else "rgba(239,83,80,.35)"})

    chart_html = f"""
    <!DOCTYPE html>
    <html><head>
    <script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
    <style>
      * {{ margin:0; padding:0; box-sizing:border-box; }}
      body {{ background:{BG}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; overflow:hidden; }}
      .wrapper {{ display:flex; height:600px; }}
      .toolbar {{ width:40px; background:{PANEL}; border-right:1px solid {BORDER};
                  display:flex; flex-direction:column; align-items:center; padding-top:8px; gap:4px; }}
      .toolbar .tb {{ width:28px; height:28px; display:flex; align-items:center; justify-content:center;
                     cursor:pointer; border-radius:4px; color:{DIM}; }}
      .toolbar .tb:hover {{ background:{BORDER}; color:{TXT}; }}
      .chart-area {{ flex:1; display:flex; flex-direction:column; }}
      .ohlc-bar {{ display:flex; align-items:center; gap:10px; padding:4px 8px;
                   font-family:'SF Mono','Fira Code','Cascadia Code',monospace; font-size:12px;
                   color:{DIM}; border-bottom:1px solid {BORDER}; background:{BG}; min-height:28px; }}
      .ohlc-bar .sym {{ font-weight:700; font-size:13px; color:{TXT}; margin-right:4px; }}
      .ohlc-bar .tf {{ color:{DIM}; font-size:11px; margin-right:8px; }}
      .ohlc-bar .lbl {{ color:{DIM}; }}
      .ohlc-bar .val {{ font-weight:600; }}
      .ohlc-bar .sma {{ color:{BLUE}; }}
      #chart-container {{ flex:1; }}
    </style>
    </head><body>
    <div class="wrapper">
      <div class="toolbar">
        <div class="tb" title="Crosshair"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="1" x2="8" y2="15"/><line x1="1" y1="8" x2="15" y2="8"/><circle cx="8" cy="8" r="3"/></svg></div>
        <div class="tb" title="Trend Line"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="14" x2="14" y2="2"/></svg></div>
        <div class="tb" title="Fib Retracement"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="1" y1="3" x2="15" y2="3"/><line x1="1" y1="8" x2="15" y2="8" stroke-dasharray="3 2"/><line x1="1" y1="13" x2="15" y2="13"/></svg></div>
        <div class="tb" title="Text"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><text x="3" y="13" font-size="13" fill="currentColor" stroke="none" font-weight="700">T</text></svg></div>
        <div class="tb" title="Ruler"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="8" rx="1"/><line x1="5" y1="4" x2="5" y2="7"/><line x1="8" y1="4" x2="8" y2="9"/><line x1="11" y1="4" x2="11" y2="7"/></svg></div>
        <div class="tb" title="Magnet"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2v4a4 4 0 0 0 8 0V2"/><line x1="4" y1="4" x2="4" y2="2" stroke-width="3"/><line x1="12" y1="4" x2="12" y2="2" stroke-width="3"/></svg></div>
      </div>
      <div class="chart-area">
        <div class="ohlc-bar">
          <span class="sym">{sel}</span>
          <span class="tf">{tf} · {ex_name}</span>
          <span><span class="lbl">O </span><span class="val" id="vO">{float(L['Open']):,.2f}</span></span>
          <span><span class="lbl">H </span><span class="val" id="vH">{float(L['High']):,.2f}</span></span>
          <span><span class="lbl">L </span><span class="val" id="vL">{float(L['Low']):,.2f}</span></span>
          <span><span class="lbl">C </span><span class="val" id="vC">{cl:,.2f}</span></span>
          <span class="sma"><span class="lbl">SMA20 </span><span class="val" id="vS">{f'{sv:,.2f}' if sv else '--'}</span></span>
        </div>
        <div id="chart-container"></div>
      </div>
    </div>
    <script>
    (function() {{
      const cData = {json.dumps(cnd)};
      const sData = {json.dumps(sma_data)};
      const vData = {json.dumps(vol_data)};

      const container = document.getElementById('chart-container');
      const chart = LightweightCharts.createChart(container, {{
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {{
          background: {{ type: 'solid', color: '{BG}' }},
          textColor: '{DIM}',
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          fontSize: 11
        }},
        grid: {{
          vertLines: {{ color: '{BORDER}' }},
          horzLines: {{ color: '{BORDER}' }}
        }},
        crosshair: {{
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: {{ color: '{DIM}', width: 1, style: LightweightCharts.LineStyle.Dashed }},
          horzLine: {{ color: '{DIM}', width: 1, style: LightweightCharts.LineStyle.Dashed }}
        }},
        rightPriceScale: {{
          borderColor: '{BORDER}',
          scaleMargins: {{ top: 0.05, bottom: 0.18 }}
        }},
        timeScale: {{
          timeVisible: true,
          secondsVisible: false,
          borderColor: '{BORDER}'
        }}
      }});

      const candleSeries = chart.addCandlestickSeries({{
        upColor: '{CYAN}',
        downColor: '{RED}',
        borderVisible: false,
        wickUpColor: '{CYAN}',
        wickDownColor: '{RED}'
      }});
      candleSeries.setData(cData);

      // current price line
      if (cData.length > 0) {{
        const lastPrice = cData[cData.length - 1].close;
        candleSeries.createPriceLine({{
          price: lastPrice,
          color: '{BLUE}',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: ''
        }});
      }}

      const smaSeries = chart.addLineSeries({{
        color: '{BLUE}',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false
      }});
      smaSeries.setData(sData);

      const volSeries = chart.addHistogramSeries({{
        priceFormat: {{ type: 'volume' }},
        priceScaleId: 'vol'
      }});
      volSeries.priceScale().applyOptions({{
        scaleMargins: {{ top: 0.85, bottom: 0 }}
      }});
      volSeries.setData(vData);

      chart.timeScale().fitContent();

      // crosshair hover updates OHLC
      const vO = document.getElementById('vO');
      const vH = document.getElementById('vH');
      const vL = document.getElementById('vL');
      const vC = document.getElementById('vC');
      const vS = document.getElementById('vS');
      const fmt = (n) => n == null ? '--' : n.toLocaleString('en-US', {{minimumFractionDigits:2, maximumFractionDigits:2}});

      chart.subscribeCrosshairMove((param) => {{
        if (!param || !param.time) {{
          // reset to latest bar
          const last = cData[cData.length - 1];
          if (last) {{
            vO.textContent = fmt(last.open);
            vH.textContent = fmt(last.high);
            vL.textContent = fmt(last.low);
            vC.textContent = fmt(last.close);
            const col = last.close >= last.open ? '{CYAN}' : '{RED}';
            vO.style.color = col; vH.style.color = col; vL.style.color = col; vC.style.color = col;
          }}
          const sLast = sData.length ? sData[sData.length - 1] : null;
          vS.textContent = sLast ? fmt(sLast.value) : '--';
          return;
        }}
        const cd = param.seriesData.get(candleSeries);
        if (cd) {{
          vO.textContent = fmt(cd.open);
          vH.textContent = fmt(cd.high);
          vL.textContent = fmt(cd.low);
          vC.textContent = fmt(cd.close);
          const col = cd.close >= cd.open ? '{CYAN}' : '{RED}';
          vO.style.color = col; vH.style.color = col; vL.style.color = col; vC.style.color = col;
        }}
        const sd = param.seriesData.get(smaSeries);
        vS.textContent = sd ? fmt(sd.value) : '--';
      }});

      // responsive resize
      const ro = new ResizeObserver(() => {{
        chart.applyOptions({{ width: container.clientWidth, height: container.clientHeight }});
      }});
      ro.observe(container);
    }})();
    </script>
    </body></html>
    """

    components.html(chart_html, height=620)

# ── WATCHLIST COLUMN ─────────────────────────────────────────────────────────
with wl_col:
    # header
    st.markdown(f'<div style="display:flex;justify-content:space-between;padding:0 0 4px;'
                f'border-bottom:1px solid {BORDER}">'
                f'<span style="font-weight:700;font-size:.9rem;color:{TXT}">Watchlist</span>'
                f'<span style="font-size:.7rem;color:{DIM}">{len(st.session_state.watchlist)} symbols</span>'
                f'</div>', unsafe_allow_html=True)

    # search
    with st.form("af", clear_on_submit=True):
        f1,f2=st.columns([5,1])
        with f1: ns=st.text_input("a",placeholder="AAPL, MSFT …",label_visibility="collapsed")
        with f2: sub=st.form_submit_button("＋",use_container_width=True)
        if sub and ns.strip():
            for s in [x.strip().upper() for x in ns.replace(","," ").split() if x.strip()]:
                if s not in st.session_state.watchlist: st.session_state.watchlist.append(s)
            st.session_state.selected=s; st.rerun()

    # selector
    wl=st.session_state.watchlist; ix=wl.index(sel) if sel in wl else 0
    pk=st.selectbox("s",wl,index=ix,label_visibility="collapsed")
    if pk!=sel: st.session_state.selected=pk; st.rerun()

    # presets popover
    with st.popover("Quick Add ▾", use_container_width=True):
        for label,syms in PRESETS.items():
            if st.button(label,key=f"p_{label}",use_container_width=True):
                for s in syms:
                    if s not in st.session_state.watchlist: st.session_state.watchlist.append(s)
                st.session_state.selected=syms[0]; st.rerun()

    # scrollable table (fixed height container)
    rh=""
    for tk in wl:
        q=quotes.get(tk,(None,None,None)); px,cg,pt=q
        ac="a" if tk==sel else ""; dc=_dc(tk)
        if px is not None:
            vc=CYAN if cg>=0 else RED; sg="+" if cg>=0 else ""
            rh+=f'<tr class="{ac}"><td><span class="d" style="background:{dc}"></span>{tk}</td><td>{px:,.2f}</td><td style="color:{vc}">{sg}{cg:,.2f}</td><td style="color:{vc}">{sg}{pt:.2f}%</td></tr>'
        else:
            rh+=f'<tr class="{ac}"><td><span class="d" style="background:{dc}"></span>{tk}</td><td>—</td><td>—</td><td>—</td></tr>'

    wl_height = 280 if len(wl) > 10 else 180
    st.markdown(f'<div style="max-height:{wl_height}px;overflow-y:auto"><table class="wt">'
                f'<tr><th>Symbol</th><th>Last</th><th>Chg</th><th>Chg%</th></tr>'
                f'{rh}</table></div>', unsafe_allow_html=True)

    # detail card + extended
    nm,ex,sec=get_info(sel); q=quotes.get(sel,(None,None,None)); px,cg,pt=q
    if px is not None:
        cr=CYAN if cg>=0 else RED; sn="+" if cg>=0 else ""
        ep,et=get_ext_quote(sel); eh=""
        if ep is not None:
            ec=ep-px; epc=(ec/px*100) if px else 0
            ecr=CYAN if ec>=0 else RED; esn="+" if ec>=0 else ""
            hr=et.hour if hasattr(et,'hour') else 0
            lb="Pre-market" if hr<10 else "Post-market"
            eh=(f'<div class="po"><div class="px" style="color:{ecr}">{ep:,.2f} '
                f'<span style="font-size:.75rem;color:{DIM}">USD</span></div>'
                f'<div class="ch" style="color:{ecr}">{esn}{ec:,.2f} ({esn}{epc:.2f}%)</div>'
                f'<div style="font-size:.68rem;color:{DIM}"><span class="pd"></span>{lb}</div></div>')
        st.markdown(f'<div class="det"><div class="n"><span class="d" style="background:{_dc(sel)}"></span>{sel}</div>'
                    f'<div class="m">{nm}·{ex}<br>{sec}</div>'
                    f'<div class="px" style="color:{cr}">{px:,.2f} <span style="font-size:.75rem;color:{DIM}">USD</span></div>'
                    f'<div class="ch" style="color:{cr}">{sn}{cg:,.2f} ({sn}{pt:.2f}%)</div>{eh}</div>',
                    unsafe_allow_html=True)

    # manage popover
    with st.popover("Manage ▾", use_container_width=True):
        rm=st.multiselect("Remove",wl,placeholder="Pick symbols…")
        c1,c2=st.columns(2)
        with c1:
            if st.button("Remove",disabled=not rm,use_container_width=True):
                for t in rm:
                    if t in st.session_state.watchlist: st.session_state.watchlist.remove(t)
                if sel in rm:
                    st.session_state.selected=st.session_state.watchlist[0] if st.session_state.watchlist else ""
                st.rerun()
        with c2:
            if st.button("Clear All",use_container_width=True):
                st.session_state.watchlist=[]; st.session_state.selected=""; st.rerun()
