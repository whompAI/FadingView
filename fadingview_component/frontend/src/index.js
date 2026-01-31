import { Streamlit } from "streamlit-component-lib";

if (!window._FV_STATE) {
  window._FV_STATE = {
    initialized: false,
    watchlist: [],
    selected: null,
    chart: null,
    splitInstance: null,
    sortableInstance: null,
  };
}

var state = window._FV_STATE;

function onRender(event) {
  const { args } = event.detail;

  if (!state.initialized) {
    initializeApp();
    state.initialized = true;
  }

  updateData(args);
}

function initializeApp() {
  const root = document.getElementById("root") || document.body;

  if (root.getAttribute("data-fv-built")) return;

  root.innerHTML = `
    <div id="container" style="width:100vw;height:100vh;display:flex;background:#0d1117;color:#c9d1d9;font-family:sans-serif;">
      <div id="panel-left" style="width:25%;min-width:150px;max-width:400px;overflow-y:auto;border-right:1px solid #30363d;padding:10px;box-sizing:border-box;">
        <h3 style="margin:0 0 10px 0;font-size:14px;color:#8b949e;">WATCHLIST</h3>
        <input id="search-input" type="text" placeholder="Add symbol..." style="width:100%;padding:6px;background:#21262d;border:1px solid #30363d;color:inherit;border-radius:4px;margin-bottom:10px;">
        <div id="watchlist-container"></div>
      </div>
      <div id="panel-right" style="flex:1;position:relative;">
        <div id="chart-area" style="width:100%;height:100%;"></div>
      </div>
    </div>
  `;

  root.setAttribute("data-fv-built", "true");

  if (state.splitInstance && typeof state.splitInstance.destroy === "function") {
    state.splitInstance.destroy();
  }

  if (window.Split) {
    state.splitInstance = window.Split(["#panel-left", "#panel-right"], {
      sizes: [25, 75],
      minSize: [150, 300],
      gutterSize: 4,
      cursor: "col-resize",
      onDragEnd: function (sizes) {
        localStorage.setItem("fv_panel_sizes", JSON.stringify(sizes));
      },
    });

    const savedSizes = localStorage.getItem("fv_panel_sizes");
    if (savedSizes) {
      try {
        state.splitInstance.setSizes(JSON.parse(savedSizes));
      } catch (e) {
        // ignore
      }
    }
  }

  setupEventListeners();
}

function updateData(args) {
  if (args.watchlist && !arraysEqual(args.watchlist, state.watchlist)) {
    state.watchlist = args.watchlist;
    renderWatchlist();
  }

  if (args.selected && args.selected !== state.selected) {
    state.selected = args.selected;
    document.querySelectorAll(".watchlist-item").forEach((el) => {
      el.style.background = el.dataset.symbol === args.selected ? "#238636" : "transparent";
    });
  }

  if (args.chart_data && window.LightweightCharts) {
    updateChart(args.chart_data, args.selected);
  }
}

function addSymbol(symbol) {
  const sym = String(symbol || "").toUpperCase().trim();
  if (!sym || state.watchlist.includes(sym)) return;

  state.watchlist.push(sym);
  renderWatchlist();

  Streamlit.setComponentValue({
    type: "update_watchlist",
    watchlist: state.watchlist,
    timestamp: Date.now(),
  });

  selectSymbol(sym);
}

function selectSymbol(symbol) {
  state.selected = symbol;
  renderWatchlist();

  Streamlit.setComponentValue({
    type: "request_data",
    symbol,
    timestamp: Date.now(),
  });
}

function removeSymbol(symbol, event) {
  event.stopPropagation();
  const idx = state.watchlist.indexOf(symbol);
  if (idx > -1) {
    state.watchlist.splice(idx, 1);
    renderWatchlist();

    Streamlit.setComponentValue({
      type: "update_watchlist",
      watchlist: state.watchlist,
    });
  }
}

function renderWatchlist() {
  const container = document.getElementById("watchlist-container");
  if (!container) return;

  container.innerHTML = state.watchlist
    .map(
      (sym) => `
    <div class="watchlist-item" data-symbol="${sym}" style="display:flex;justify-content:space-between;padding:8px;cursor:pointer;border-radius:4px;margin-bottom:2px;background:${sym === state.selected ? "#238636" : "transparent"};hover{background:#21262d;}">
      <span style="font-weight:bold;">${sym}</span>
      <button onclick="window._FV_remove('${sym}', event)" style="background:none;border:none;color:#f85149;cursor:pointer;padding:0 4px;font-size:16px;line-height:1;">×</button>
    </div>
  `
    )
    .join("");
}

function setupEventListeners() {
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && e.target.value) {
        addSymbol(e.target.value);
        e.target.value = "";
      }
    });
  }

  const container = document.getElementById("watchlist-container");
  if (container) {
    container.addEventListener("click", (e) => {
      const item = e.target.closest(".watchlist-item");
      if (item) {
        selectSymbol(item.dataset.symbol);
      }
    });
  }

  window._FV_remove = removeSymbol;
}

function updateChart(data) {
  if (!data || !data.length) return;

  const chartContainer = document.getElementById("chart-area");
  if (!chartContainer) return;

  if (state.chart) {
    state.chart.remove();
    state.chart = null;
  }

  const chart = window.LightweightCharts.createChart(chartContainer, {
    width: chartContainer.clientWidth,
    height: chartContainer.clientHeight,
    layout: { background: { color: "#0d1117" }, textColor: "#c9d1d9" },
    grid: { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
  });

  const candleSeries = chart.addCandlestickSeries();
  const formattedData = data.map((d) => ({
    time: new Date(d.Datetime || d.Date).getTime() / 1000,
    open: d.Open,
    high: d.High,
    low: d.Low,
    close: d.Close,
  }));

  candleSeries.setData(formattedData);
  chart.timeScale().fitContent();

  state.chart = chart;

  window.addEventListener("resize", () => {
    if (state.chart) {
      state.chart.resize(chartContainer.clientWidth, chartContainer.clientHeight);
    }
  });
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

Streamlit.events.addEventListener(Streamlit.RENDER_EVENT, onRender);
Streamlit.setComponentReady();
Streamlit.setFrameHeight(800);
