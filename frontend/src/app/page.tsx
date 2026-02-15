"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineSeries,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

type Candle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type LinePoint = {
  time: UTCTimestamp;
  value: number;
};

type VolumePoint = {
  time: UTCTimestamp;
  value: number;
  color?: string;
};

type SymbolResult = {
  symbol: string;
  name?: string;
  exchange?: string;
  type?: string;
};

type Quote = {
  price: number;
  change: number;
  changePct: number;
  spark?: number[];
  exchange?: string;
  name?: string;
  currency?: string;
  session?: string;
  lastTs?: number;
  rthPrice?: number;
  rthChange?: number;
  rthChangePct?: number;
  extPrice?: number;
  extChange?: number;
  extChangePct?: number;
};

type DeltaPayload = {
  candles?: Candle[];
  ext_candles?: Candle[];
  volume?: VolumePoint[];
  indicators?: {
    sma20?: LinePoint[];
    sma50?: LinePoint[];
    sma200?: LinePoint[];
    ema12?: LinePoint[];
    ema26?: LinePoint[];
    rsi14?: LinePoint[];
    vwap?: LinePoint[];
  };
};

type QuotesWire = {
  price?: number;
  change?: number;
  change_pct?: number;
  spark?: number[];
  exchange?: string;
  name?: string;
  currency?: string;
  session?: string;
  last_ts?: number;
  rth_price?: number;
  rth_change?: number;
  rth_change_pct?: number;
  ext_price?: number;
  ext_change?: number;
  ext_change_pct?: number;
};

type QuotesApiResponse = {
  quotes?: Record<string, QuotesWire>;
  stale?: boolean;
};

const sanitizeCandles = (items: Candle[]) =>
  items.filter((item) =>
    [item.open, item.high, item.low, item.close].every(
      (value) => typeof value === "number" && Number.isFinite(value)
    )
  );

const filterUnconfirmedSpikeCandles = (items: Candle[]): Candle[] => {
  if (items.length < 6) return items;
  const keep = new Array(items.length).fill(true);
  const closes = items.map((item) => item.close);

  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const refStart = Math.max(0, i - 48);
    const ref = closes.slice(refStart, i);
    if (ref.length < 12) continue;
    const baseline = median(ref);
    if (!baseline || baseline <= 0) continue;

    const devPct = Math.abs(item.close - baseline) / baseline;
    const rangePct = Math.abs(item.high - item.low) / baseline;
    const extreme = devPct > 0.35 && rangePct > 0.03;
    if (!extreme) continue;

    const next = items[i + 1];
    if (!next) {
      keep[i] = false;
      continue;
    }
    const followThrough = Math.abs(next.close - item.close) / Math.max(Math.abs(item.close), 1e-9);
    if (followThrough > 0.12) {
      keep[i] = false;
    }
  }

  return items.filter((_, idx) => keep[idx]);
};

const toEpochSeconds = (time: Time | null | undefined): number | null => {
  if (typeof time === "number") return time;
  if (!time) return null;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  if ("year" in time) {
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  }
  return null;
};

const toUtcTimestamp = (time: number): UTCTimestamp => {
  return time as UTCTimestamp;
};

const toUtcTimestampSafe = (
  time: Time | number | null | undefined
): UTCTimestamp => {
  if (typeof time === "number") return toUtcTimestamp(time);
  const seconds = toEpochSeconds(time);
  return toUtcTimestamp(seconds ?? 0);
};

const mergeByTime = <T extends { time: UTCTimestamp }>(
  prev: T[],
  incoming: T[]
): T[] => {
  if (!incoming.length) return prev;
  const map = new Map<number, T>();
  prev.forEach((item) => map.set(item.time, item));
  incoming.forEach((item) => map.set(item.time, item));
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
};

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "NVDA", "MSFT"];
const CORE_TIMEFRAMES = ["1h", "4h", "1d", "1w"];
const ADVANCED_TIMEFRAMES = ["1m", "5m", "15m", "30m"];
const DEFAULT_TIMEFRAME = "1h";
const MAX_WATCHLIST = 50;
const WATCHLIST_LAYOUT_DEFAULT = { items: 40, selected: 24, news: 36 };
const WATCHLIST_LAYOUT_MIN_ITEMS = 18;
const WATCHLIST_LAYOUT_MIN_SELECTED = 16;
const WATCHLIST_LAYOUT_MIN_NEWS = 20;

const clampPercent = (value: number, min: number, max: number): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};
const AUTH_TOKEN_KEY = "fv_auth_token";
const TIMEFRAME_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

export default function Home() {
  // In production we want same-origin calls via nginx ("/api/*").
  // In local dev you can set NEXT_PUBLIC_API_BASE=http://127.0.0.1:8001.
  const apiBase = useMemo(() => {
    const envBase = process.env.NEXT_PUBLIC_API_BASE;
    return envBase && envBase.trim().length ? envBase.trim() : "";
  }, []);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const extSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sma20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const sma200Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema12Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema26Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const rsiChartRef = useRef<HTMLDivElement | null>(null);
  const rsiChartApiRef = useRef<IChartApi | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const lastCandleRef = useRef<Candle | null>(null);
  const defaultViewRef = useRef<boolean>(true);
  const candlesRef = useRef<Candle[]>([]);
  const extCandlesRef = useRef<Candle[]>([]);
  const extEnabledRef = useRef<boolean>(false);
  const resizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const urlStateReadyRef = useRef<boolean>(false);
  const fullFetchSeqRef = useRef<number>(0);
  const lastLoadedDataKeyRef = useRef<string>("");
  const [embedConfig] = useState(() => {
    if (typeof window === "undefined") {
      return { isEmbed: false, forcedSymbol: "" };
    }
    const params = new URLSearchParams(window.location.search);
    const rawSymbol = (params.get("symbol") ?? "")
      .toUpperCase()
      .trim()
      .replace(/[^A-Z0-9=.\-^/]/g, "");
    const chromeOff = params.get("chrome") == "0";
    const mode = (params.get("mode") ?? "").toLowerCase();
    return {
      isEmbed: params.get("embed") === "1",
      forcedSymbol: rawSymbol,
      chromeOff,
      canvasOnly: chromeOff && mode == "canvas",
    };
  });
  const isEmbedMode = embedConfig.isEmbed;
  const forcedEmbedSymbol = embedConfig.forcedSymbol;
  const initialUrlSymbol = forcedEmbedSymbol;

  const isCanvasOnly = isEmbedMode && !!(embedConfig as any).canvasOnly;

  useEffect(() => {
    if (!isEmbedMode) return;
    document.documentElement.classList.add("whomp-embed");
    if (isCanvasOnly) document.documentElement.classList.add("whomp-embed-canvas");
    return () => {
      document.documentElement.classList.remove("whomp-embed");
      document.documentElement.classList.remove("whomp-embed-canvas");
    };
  }, [isEmbedMode, isCanvasOnly]);

  const [watchlist, setWatchlist] = useState<string[]>(
    () =>
      isEmbedMode && forcedEmbedSymbol
        ? [forcedEmbedSymbol]
        : DEFAULT_WATCHLIST
  );
  const [authToken, setAuthToken] = useState<string>("");
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [sessionAuthorized, setSessionAuthorized] = useState<boolean>(false);
  const [syncState, setSyncState] = useState<"local" | "syncing" | "synced" | "error">("local");
  const [showLogin, setShowLogin] = useState<boolean>(false);
  const [loginUsername, setLoginUsername] = useState<string>("");
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const serverHydratedRef = useRef<boolean>(false);
  const serverSaveTimerRef = useRef<number | null>(null);
  const [selected, setSelected] = useState<string>(
    () =>
      isEmbedMode && forcedEmbedSymbol
        ? forcedEmbedSymbol
        : DEFAULT_WATCHLIST[0]
  );
  const [timeframe, setTimeframe] = useState<string>(DEFAULT_TIMEFRAME);
  const [extEnabled, setExtEnabled] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SymbolResult[]>([]);
  const [watchlistLayout, setWatchlistLayout] = useState(WATCHLIST_LAYOUT_DEFAULT);
  const watchlistLayoutRef = useRef(WATCHLIST_LAYOUT_DEFAULT);
  const watchlistSectionRef = useRef<HTMLDivElement | null>(null);
  const activeWatchlistHandleRef = useRef<"items" | "selected" | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [extCandles, setExtCandles] = useState<Candle[]>([]);
  const [indicatorData, setIndicatorData] = useState<{
    sma20: LinePoint[];
    sma50: LinePoint[];
    sma200: LinePoint[];
    ema12: LinePoint[];
    ema26: LinePoint[];
    rsi14: LinePoint[];
    vwap: LinePoint[];
  }>({
    sma20: [],
    sma50: [],
    sma200: [],
    ema12: [],
    ema26: [],
    rsi14: [],
    vwap: [],
  });
  const [volumeData, setVolumeData] = useState<VolumePoint[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesStale, setQuotesStale] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>("offline");
  const [streamMode, setStreamMode] = useState<"stream" | "reconnecting" | "polling">("stream");
  const [clockTs, setClockTs] = useState<number>(Date.now());
  const [chartMenu, setChartMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
  }>({ open: false, x: 0, y: 0 });
  const [ohlc, setOhlc] = useState<Candle | null>(null);
  const [showSma20, setShowSma20] = useState<boolean>(false);
  const [showSma50, setShowSma50] = useState<boolean>(false);
  const [showSma200, setShowSma200] = useState<boolean>(false);
  const [showEma12, setShowEma12] = useState<boolean>(false);
  const [showEma26, setShowEma26] = useState<boolean>(false);
  const [showVolume, setShowVolume] = useState<boolean>(true);
  const [showRsi, setShowRsi] = useState<boolean>(false);
  const [showVwap, setShowVwap] = useState<boolean>(false);
  const [showIndicatorPanel, setShowIndicatorPanel] = useState<boolean>(false);
  const [newsItems, setNewsItems] = useState<
    { title: string; source?: string; time?: string; url?: string }[]
  >([]);
  const [newsError, setNewsError] = useState<string | null>(null);
  const selectedQuote = quotes[selected];
  const headerPrice = selectedQuote?.price;
  const headerChange = selectedQuote?.changePct;
  const headerName = selectedQuote?.name;
  const headerExchange = formatExchangeLabel(selectedQuote?.exchange, selected);
  const headerSession = selectedQuote?.session;
  const detailRthPrice = selectedQuote?.rthPrice ?? selectedQuote?.price;
  const detailRthChange = selectedQuote?.rthChange ?? selectedQuote?.change;
  const detailRthChangePct = selectedQuote?.rthChangePct ?? selectedQuote?.changePct;
  const detailExtPrice = selectedQuote?.extPrice;
  const detailExtChange = selectedQuote?.extChange;
  const detailExtChangePct = selectedQuote?.extChangePct;
  const showExtDetail =
    selectedQuote?.session &&
    selectedQuote.session !== "rth" &&
    detailExtPrice != null;
  const extDetailLabel =
    selectedQuote?.session === "pre" ? "Pre" : "Post";
  const watchlistKey = useMemo(() => watchlist.join(","), [watchlist]);
  const accessLocked = !isEmbedMode && authChecked && !sessionAuthorized;

  const normalizeSymbol = (value: string): string =>
    value.toUpperCase().trim().replace(/[^A-Z0-9=.\-^/]/g, "");

  function formatExchangeLabel(exchange?: string, symbol?: string): string {
    const code = (exchange || "").toUpperCase().trim();
    const symbolText = (symbol || "").toUpperCase().trim();

    if (!code && !symbolText) return "—";

    if (symbolText === "NQ" || symbolText === "ES") return symbolText;
    if (symbolText === "QQQ" || symbolText === "SPY") return symbolText;

    const normalized = code.replace(/[^A-Z0-9]/g, "");
    if (!normalized) return "—";

    if (
      normalized.includes("NMS") ||
      normalized.includes("XNMS") ||
      normalized.includes("XNCM") ||
      normalized.includes("XNAS") ||
      normalized.includes("NSDQ") ||
      normalized.includes("NASD") ||
      normalized.includes("NASDAQ")
    ) {
      return "NASDAQ";
    }

    const exchangeMap: Record<string, string> = {
      BATS: "BATS",
      ARCA: "ARCA",
      XASE: "AMEX",
      AMEX: "AMEX",
      NYS: "NYSE",
      NYQ: "NYSE",
      XNYS: "NYSE",
      CBOE: "CBOE",
      CME: "CME",
      NYMEX: "NYMEX",
      COMEX: "COMEX",
      ICE: "ICE",
    };

    return exchangeMap[normalized] || normalized;
  };
  const isRthSession = () => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date());
      const get = (type: string) => parts.find((p) => p.type === type)?.value;
      const weekday = get("weekday") || "";
      const hour = Number(get("hour") || "0");
      const minute = Number(get("minute") || "0");
      const isWeekend = weekday === "Sat" || weekday === "Sun";
      if (isWeekend) return false;
      const minutes = hour * 60 + minute;
      return minutes >= 570 && minutes < 960; // 09:30 - 16:00 ET
    } catch {
      return false;
    }
  };

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch(`${apiBase}/api/health`);
        if (!res.ok) throw new Error("health failed");
        const json = await res.json();
        setHealth(json.status || "ok");
      } catch {
        setHealth("offline");
      }
    };
    fetchHealth();
  }, [apiBase]);

  useEffect(() => {
    const id = window.setInterval(() => setClockTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!chartMenu.open) return;
    const close = () => setChartMenu((prev) => ({ ...prev, open: false }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [chartMenu.open]);

  useEffect(() => {
    extEnabledRef.current = extEnabled;
  }, [extEnabled]);

  useEffect(() => {
    if (isEmbedMode) {
      if (forcedEmbedSymbol) {
        setWatchlist([forcedEmbedSymbol]);
        setSelected(forcedEmbedSymbol);
      }
      return;
    }
    const storedToken = window.localStorage.getItem(AUTH_TOKEN_KEY);
    if (storedToken && storedToken.trim().length) {
      setAuthToken(storedToken.trim());
      const token = storedToken.trim();
    }
    const storedWatchlist = window.localStorage.getItem("fv_watchlist");
    const storedSelected = window.localStorage.getItem("fv_selected");
    if (storedWatchlist) {
      try {
        const parsed = JSON.parse(storedWatchlist);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          const nextList = parsed.map((item) => item.toUpperCase().trim()).filter(Boolean);
          const trimmed = nextList.slice(-MAX_WATCHLIST);
          setWatchlist(trimmed);
          if (trimmed.length) {
            if (storedSelected && trimmed.includes(storedSelected)) {
              setSelected(storedSelected);
            } else {
              setSelected(trimmed[0]);
            }
          } else {
            setSelected("");
          }
        }
      } catch {
        // Ignore invalid localStorage data.
      }
    }
  }, [isEmbedMode, forcedEmbedSymbol]);

  useEffect(() => {
    if (isEmbedMode) {
      setSessionAuthorized(true);
      setAuthChecked(true);
      setSyncState("local");
      setShowLogin(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        setSyncState("syncing");
        const headers: Record<string, string> = {};
        if (authToken) {
          headers.authorization = `Bearer ${authToken}`;
        }

        const res = await fetch(`${apiBase}/api/watchlist`, {
          headers,
          cache: "no-store",
        });

        if (res.status === 401) {
          // Either token expired or no shared cookie session exists.
          window.localStorage.removeItem(AUTH_TOKEN_KEY);
          if (!cancelled) {
            setAuthToken("");
            setSyncState("local");
            setShowLogin(true);
            setSessionAuthorized(false);
            setAuthChecked(true);
          }
          // Best-effort: clear server-managed cookie session too.
          try {
            await fetch(`${apiBase}/api/auth/logout`, { method: "POST", cache: "no-store" });
          } catch {
            // Ignore.
          }
          return;
        }

        if (!res.ok) throw new Error("watchlist fetch failed");
        const json = await res.json();
        if (cancelled) return;
        const symbols = Array.isArray(json.symbols) ? json.symbols : [];
        const normalized = symbols
          .map((item: unknown) => String(item || "").toUpperCase().trim())
          .filter(Boolean)
          .slice(-MAX_WATCHLIST);
        const serverSelected = typeof json.selected_symbol === "string" ? json.selected_symbol : "";
        if (initialUrlSymbol) {
          // URL symbol takes precedence over synced watchlist selection.
          const merged = [initialUrlSymbol, ...normalized.filter((item: string) => item !== initialUrlSymbol)].slice(
            0,
            MAX_WATCHLIST
          );
          setWatchlist(merged);
          setSelected(initialUrlSymbol);
        } else if (normalized.length) {
          setWatchlist(normalized);
          setSelected(serverSelected && normalized.includes(serverSelected) ? serverSelected : normalized[0]);
        }
        serverHydratedRef.current = true;
        setShowLogin(false);
        setSyncState("synced");
        setSessionAuthorized(true);
        setAuthChecked(true);
      } catch {
        if (!cancelled) {
          setSyncState("error");
          setAuthChecked(true);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, authToken, isEmbedMode, initialUrlSymbol]);

  useEffect(() => {
    const override = window.sessionStorage.getItem("fv_ext_override");
    if (override === "1") {
      setExtEnabled(true);
      return;
    }
    if (override === "0") {
      setExtEnabled(false);
      return;
    }
    setExtEnabled(!isRthSession());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const symbolParam = params.get("symbol");
    const tfParam = params.get("tf");
    const extParam = params.get("ext");
    const allFrames = [...ADVANCED_TIMEFRAMES, ...CORE_TIMEFRAMES];

    if (symbolParam) {
      const normalized = normalizeSymbol(symbolParam);
      if (normalized) {
        if (isEmbedMode) {
          setSelected(normalized);
          setWatchlist([normalized]);
        } else {
          setSelected(normalized);
          setWatchlist((prev) => {
            if (prev.includes(normalized)) return prev;
            return [normalized, ...prev].slice(0, MAX_WATCHLIST);
          });
        }
      }
    } else if (isEmbedMode && forcedEmbedSymbol) {
      setSelected(forcedEmbedSymbol);
      setWatchlist([forcedEmbedSymbol]);
    }

    if (tfParam) {
      const tf = tfParam.toLowerCase();
      if (allFrames.includes(tf)) {
        setTimeframe(tf);
      }
    }

    if (extParam === "1" || extParam === "0") {
      const next = extParam === "1";
      setExtEnabled(next);
      window.sessionStorage.setItem("fv_ext_override", next ? "1" : "0");
    }

    urlStateReadyRef.current = true;
  }, [isEmbedMode, forcedEmbedSymbol]);

  useEffect(() => {
    if (!isEmbedMode || !forcedEmbedSymbol) return;
    if (selected !== forcedEmbedSymbol) {
      setSelected(forcedEmbedSymbol);
    }
    setWatchlist((prev) => {
      if (prev.length === 1 && prev[0] === forcedEmbedSymbol) return prev;
      return [forcedEmbedSymbol];
    });
  }, [isEmbedMode, forcedEmbedSymbol, selected]);

  useEffect(() => {
    const storedIndicators = window.localStorage.getItem("fv_indicators");
    if (!storedIndicators) return;
    try {
      const parsed = JSON.parse(storedIndicators);
      if (typeof parsed !== "object" || !parsed) return;
      if (typeof parsed.showSma20 === "boolean") setShowSma20(parsed.showSma20);
      if (typeof parsed.showSma50 === "boolean") setShowSma50(parsed.showSma50);
      if (typeof parsed.showSma200 === "boolean") setShowSma200(parsed.showSma200);
      if (typeof parsed.showEma12 === "boolean") setShowEma12(parsed.showEma12);
      if (typeof parsed.showEma26 === "boolean") setShowEma26(parsed.showEma26);
      if (typeof parsed.showVwap === "boolean") setShowVwap(parsed.showVwap);
      if (typeof parsed.showRsi === "boolean") setShowRsi(parsed.showRsi);
      if (typeof parsed.showVolume === "boolean") setShowVolume(parsed.showVolume);
    } catch {
      // Ignore invalid localStorage data.
    }
  }, []);

  useEffect(() => {
    if (isEmbedMode) return;
    window.localStorage.setItem("fv_watchlist", JSON.stringify(watchlist));
  }, [watchlist, isEmbedMode]);

  useEffect(() => {
    if (isEmbedMode) return;
    if (!selected) return;
    window.localStorage.setItem("fv_selected", selected);
  }, [selected, isEmbedMode]);

  useEffect(() => {
    if (isEmbedMode) return;
    if (!authToken && !sessionAuthorized) return;
    if (serverSaveTimerRef.current) {
      window.clearTimeout(serverSaveTimerRef.current);
    }
    // Debounce to avoid spamming writes while typing/adding/removing.
    serverSaveTimerRef.current = window.setTimeout(async () => {
      try {
        setSyncState("syncing");
        const res = await fetch(`${apiBase}/api/watchlist`, {
          method: "PUT",
          headers: {
              "content-type": "application/json",
              ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
            },
          body: JSON.stringify({ symbols: watchlist, selected_symbol: selected || null }),
          cache: "no-store",
        });
        if (res.status === 401) {
          window.localStorage.removeItem(AUTH_TOKEN_KEY);
          setAuthToken("");
          setSyncState("local");
          setSessionAuthorized(false);
          setAuthChecked(true);
          setShowLogin(true);
          return;
        }
        if (!res.ok) throw new Error("watchlist save failed");
        setSyncState("synced");
      } catch {
        setSyncState("error");
      }
    }, 650);
    return () => {
      if (serverSaveTimerRef.current) window.clearTimeout(serverSaveTimerRef.current);
    };
  }, [apiBase, authToken, sessionAuthorized, watchlistKey, selected, isEmbedMode]);

  useEffect(() => {
    if (!urlStateReadyRef.current || !selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set("symbol", selected);
    url.searchParams.set("tf", timeframe);
    url.searchParams.set("ext", extEnabled ? "1" : "0");
    const next = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) {
      window.history.replaceState(null, "", next);
    }
  }, [selected, timeframe, extEnabled]);


  useEffect(() => {
    const payload = {
      showSma20,
      showSma50,
      showSma200,
      showEma12,
      showEma26,
      showVwap,
      showRsi,
      showVolume,
    };
    window.localStorage.setItem("fv_indicators", JSON.stringify(payload));
  }, [
    showSma20,
    showSma50,
    showSma200,
    showEma12,
    showEma26,
    showVwap,
    showRsi,
    showVolume,
  ]);

  useEffect(() => {
    if (!selected) return;
    if (accessLocked) {
      setNewsItems([]);
      setNewsError("Sign in to enable news.");
      return;
    }

    const controller = new AbortController();
    const fetchNews = async () => {
      try {
        const url = `${apiBase}/api/news?symbol=${encodeURIComponent(selected)}&limit=10`;
        const headers: Record<string, string> = {};
        if (authToken) {
          headers.authorization = `Bearer ${authToken}`;
        }
        const res = await fetch(url, {
          signal: controller.signal,
          headers,
          cache: "no-store",
        });

        if (res.status === 401) {
          window.localStorage.removeItem(AUTH_TOKEN_KEY);
          setAuthToken("");
          setSyncState("local");
          setSessionAuthorized(false);
          setAuthChecked(true);
          setShowLogin(true);
          setNewsItems([]);
          setNewsError("Sign in to enable news.");
          return;
        }

        if (!res.ok) throw new Error("news fetch failed");
        const json = (await res.json()) as {
          items?: Array<{ title?: string; source?: string; time?: string; url?: string }>
        };
        const items = (json.items || [])
          .map((item) => ({
            title: (item.title || "").trim(),
            source: (item.source || "").trim(),
            time: item.time,
            url: item.url,
          }))
          .filter((item) => item.title.length > 0);

        setNewsItems(items);
        setNewsError(null);
      } catch {
        if (!controller.signal.aborted) {
          setNewsItems([]);
          setNewsError("News unavailable");
        }
      }
    };

    fetchNews();
    const interval = window.setInterval(fetchNews, 300000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [selected, apiBase, authToken, accessLocked]);

  useEffect(() => {
    if (![...ADVANCED_TIMEFRAMES, ...CORE_TIMEFRAMES].includes(timeframe)) {
      setTimeframe(DEFAULT_TIMEFRAME);
    }
  }, [timeframe]);

  useEffect(() => {
    if (!showRsi) return;
    if (!rsiChartRef.current || !rsiChartApiRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      if (!rsiChartRef.current || !rsiChartApiRef.current) return;
      const rect = rsiChartRef.current.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10) {
        rsiChartApiRef.current.applyOptions({
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [showRsi]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f0d" },
        textColor: "#6a7a73",
      },
      grid: {
        vertLines: { color: "#15211c" },
        horzLines: { color: "#15211c" },
      },
      rightPriceScale: { borderColor: "#1b2a24" },
      timeScale: { borderColor: "#1b2a24", timeVisible: true },
      crosshair: {
        vertLine: { color: "#6a7a73", style: 2 },
        horzLine: { color: "#6a7a73", style: 2 },
      },
    });

    let mainSeries: ISeriesApi<"Candlestick"> | null = null;
    if (typeof (chart as IChartApi).addSeries === "function") {
      mainSeries = (chart as IChartApi).addSeries(CandlestickSeries, {
        upColor: "#00d084",
        downColor: "#ff5a5f",
        borderUpColor: "#00d084",
        borderDownColor: "#ff5a5f",
      });
    }
    if (!mainSeries) return;

    let extSeries: ISeriesApi<"Candlestick"> | null = null;
    if (typeof (chart as IChartApi).addSeries === "function") {
      extSeries = (chart as IChartApi).addSeries(CandlestickSeries, {
        upColor: "rgba(21, 148, 116, 0.45)",
        downColor: "rgba(196, 75, 79, 0.45)",
        borderUpColor: "rgba(21, 148, 116, 0.45)",
        borderDownColor: "rgba(196, 75, 79, 0.45)",
        wickUpColor: "rgba(21, 148, 116, 0.4)",
        wickDownColor: "rgba(196, 75, 79, 0.4)",
      });
    }

    const sma20 = chart.addSeries(LineSeries, {
      color: "rgba(60, 196, 255, 0.7)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const sma50 = chart.addSeries(LineSeries, {
      color: "rgba(255, 180, 84, 0.65)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const sma200 = chart.addSeries(LineSeries, {
      color: "rgba(106, 122, 115, 0.6)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema12 = chart.addSeries(LineSeries, {
      color: "rgba(0, 208, 132, 0.7)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema26 = chart.addSeries(LineSeries, {
      color: "rgba(255, 90, 95, 0.65)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const vwap = chart.addSeries(LineSeries, {
      color: "rgba(122, 162, 255, 0.7)",
      lineWidth: 1,
      lineStyle: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      color: "#223b33",
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });

    chart.priceScale("").applyOptions({
      // Keep volume histogram compact at the bottom.
      scaleMargins: { top: isEmbedMode ? 0.88 : 0.8, bottom: 0 },
    });
    chart.priceScale("right").applyOptions({
      // Tighter margins prevent large dead space above candles in embed mode.
      scaleMargins: isEmbedMode ? { top: 0.02, bottom: 0.08 } : { top: 0.06, bottom: 0.14 },
    });

    chartApiRef.current = chart;
    seriesRef.current = mainSeries;
    extSeriesRef.current = extSeries;
    sma20Ref.current = sma20;
    sma50Ref.current = sma50;
    sma200Ref.current = sma200;
    ema12Ref.current = ema12;
    ema26Ref.current = ema26;
    vwapRef.current = vwap;
    volumeRef.current = volume;

    priceLineRef.current = mainSeries.createPriceLine({
      price: 0,
      color: "rgba(0,0,0,0)",
      lineWidth: 1,
      axisLabelVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      const main = seriesRef.current;
      const extSeriesLocal = extSeriesRef.current;
      if (!main || !param || !param.time) {
        if (priceLineRef.current) {
          priceLineRef.current.applyOptions({
            color: "rgba(0,0,0,0)",
            axisLabelVisible: false,
          });
        }
        if (lastCandleRef.current) {
          setOhlc(lastCandleRef.current);
        }
        return;
      }
      const mainData = param.seriesData.get(main) as Partial<Candle> | undefined;
      const extData = extSeriesLocal
        ? (param.seriesData.get(extSeriesLocal) as Partial<Candle> | undefined)
        : undefined;
      const data = mainData && mainData.open ? mainData : extData;
      if (data && data.open !== undefined && data.close !== undefined) {
        setOhlc({
          time: toUtcTimestampSafe(data.time),
          open: Number(data.open),
          high: Number(data.high),
          low: Number(data.low),
          close: Number(data.close),
        });
        if (priceLineRef.current) {
          priceLineRef.current.applyOptions({
            price: Number(data.close),
            color: Number(data.close) >= Number(data.open) ? "#00d084" : "#ff5a5f",
            axisLabelVisible: true,
          });
        }
      }
    });

    let rsiChart: IChartApi | null = null;
    let rsiSeries: ISeriesApi<"Line"> | null = null;
    let syncRange: ((range: { from: number; to: number } | null) => void) | null =
      null;

    if (rsiChartRef.current) {
      rsiChart = createChart(rsiChartRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "#0b0f0d" },
          textColor: "#6a7a73",
        },
        grid: {
          vertLines: { color: "#15211c" },
          horzLines: { color: "#15211c" },
        },
        rightPriceScale: { borderColor: "#1b2a24" },
        timeScale: { borderColor: "#1b2a24", timeVisible: false, visible: false },
        crosshair: {
          vertLine: { color: "#6a7a73", style: 2 },
          horzLine: { color: "#6a7a73", style: 2 },
        },
        handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false },
        handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
      });
      rsiSeries = rsiChart.addSeries(LineSeries, {
        color: "rgba(249, 115, 22, 0.8)",
        lineWidth: 1,
        lineStyle: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      rsiChart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.2, bottom: 0.1 },
      });
      rsiChartApiRef.current = rsiChart;
      rsiSeriesRef.current = rsiSeries;
      const mainTimeScale = chart.timeScale();
      syncRange = (range) => {
        if (range && rsiChart) {
          rsiChart.timeScale().setVisibleLogicalRange(range);
        }
      };
      mainTimeScale.subscribeVisibleLogicalRangeChange(syncRange);
    }

    const handleResize = () => {
      if (!chartRef.current) return;
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        if (!chartRef.current) return;
        const rect = chartRef.current.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width < 10 || height < 10) {
          resizeTimerRef.current = null;
          return;
        }
        if (
          lastSizeRef.current.width === width &&
          lastSizeRef.current.height === height
        ) {
          resizeTimerRef.current = null;
          return;
        }
        lastSizeRef.current = { width, height };
        chart.applyOptions({ width, height });
        if (rsiChartRef.current && rsiChart) {
          const rsiRect = rsiChartRef.current.getBoundingClientRect();
          if (rsiRect.width > 10 && rsiRect.height > 10) {
            rsiChart.applyOptions({
              width: Math.round(rsiRect.width),
              height: Math.round(rsiRect.height),
            });
          }
        }
        resizeTimerRef.current = null;
      }, 100);
    };
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(chartRef.current);
    if (rsiChartRef.current) {
      resizeObserver.observe(rsiChartRef.current);
    }
    window.addEventListener("resize", handleResize);
    const rafId = window.requestAnimationFrame(() => handleResize());

    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      if (resizeTimerRef.current) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (syncRange) {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncRange);
      }
      if (rsiChart) {
        rsiChart.remove();
      }
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const mainSeries = seriesRef.current;
    if (!mainSeries) return;
    const hasRth = candles.length > 0;
    const rthTimes = new Set<number>();
    if (hasRth) {
      candles.forEach((c) => rthTimes.add(c.time));
    }
    const extFiltered = extEnabled
      ? extCandles.filter((c) => !rthTimes.has(c.time))
      : [];
    const hasExt = extFiltered.length > 0;

    if (!hasRth && !hasExt) {
      mainSeries.setData([]);
      extSeriesRef.current?.setData([]);
      volumeRef.current?.setData([]);
      sma20Ref.current?.setData([]);
      sma50Ref.current?.setData([]);
      sma200Ref.current?.setData([]);
      ema12Ref.current?.setData([]);
      ema26Ref.current?.setData([]);
      setOhlc(null);
      return;
    }

    mainSeries.setData(candles);
    if (extSeriesRef.current) {
      extSeriesRef.current.setData(extFiltered);
    }
    if (volumeRef.current) {
      volumeRef.current.setData(showVolume ? volumeData : []);
    }
    if (sma20Ref.current) {
      sma20Ref.current.setData(showSma20 ? indicatorData.sma20 : []);
    }
    if (sma50Ref.current) {
      sma50Ref.current.setData(showSma50 ? indicatorData.sma50 : []);
    }
    if (sma200Ref.current) {
      sma200Ref.current.setData(showSma200 ? indicatorData.sma200 : []);
    }
    if (ema12Ref.current) {
      ema12Ref.current.setData(showEma12 ? indicatorData.ema12 : []);
    }
    if (ema26Ref.current) {
      ema26Ref.current.setData(showEma26 ? indicatorData.ema26 : []);
    }
    if (vwapRef.current) {
      vwapRef.current.setData(showVwap ? indicatorData.vwap : []);
    }
    if (rsiSeriesRef.current) {
      rsiSeriesRef.current.setData(showRsi ? indicatorData.rsi14 : []);
    }
    const lastRth = hasRth ? candles[candles.length - 1] : null;
    const lastExt = hasExt ? extFiltered[extFiltered.length - 1] : null;
    let last = lastRth || lastExt;
    if (lastRth && lastExt && lastExt.time > lastRth.time) {
      last = lastExt;
    }
    if (last) {
      lastCandleRef.current = last;
      setOhlc(last);
    }
    const timeScale = chartApiRef.current?.timeScale();
    if (timeScale) {
      if (defaultViewRef.current) {
        const timeSet = new Set<number>();
        candles.forEach((c) => timeSet.add(c.time));
        if (extFiltered.length) {
          extFiltered.forEach((c) => timeSet.add(c.time));
        }
        const totalBars = timeSet.size;
        const targetBarsMap: Record<string, number> = {
          "1m": 240,
          "5m": 200,
          "15m": 160,
          "30m": 140,
          "1h": 140,
          "4h": 120,
          "1d": 120,
          "1w": 120,
        };
        timeScale.resetTimeScale();
        if (totalBars > 0) {
          const targetBars = targetBarsMap[timeframe] ?? 140;
          const to = Math.max(0, totalBars - 1);
          const from = Math.max(0, to - Math.min(targetBars, totalBars) + 1);
          const barSpacing = totalBars < 30 ? 4 : totalBars < 80 ? 5 : 6;
          timeScale.applyOptions({ rightOffset: 6, barSpacing });
          timeScale.setVisibleLogicalRange({ from, to });
          chartApiRef.current?.priceScale("right").applyOptions({ autoScale: true });
        }
        defaultViewRef.current = false;
      }
    }
  }, [
    candles,
    extCandles,
    extEnabled,
    timeframe,
    indicatorData,
    volumeData,
    showSma20,
    showSma50,
    showSma200,
    showEma12,
    showEma26,
    showVwap,
    showRsi,
    showVolume,
  ]);

  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const run = async () => {
      try {
        const res = await fetch(
          `${apiBase}/api/symbols?query=${encodeURIComponent(searchQuery)}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("search failed");
        const json = await res.json();
        setSearchResults(json.results || []);
      } catch {
        if (!controller.signal.aborted) setSearchResults([]);
      }
    };
    run();
    return () => controller.abort();
  }, [apiBase, searchQuery]);

  useEffect(() => {
    if (accessLocked) {
      setQuotes({});
      setQuotesStale(false);
      return;
    }
    if (!watchlist.length) {
      setQuotes({});
      setQuotesStale(false);
      return;
    }
    const symbols = watchlistKey;
    const controller = new AbortController();
    let active = true;
    let eventSource: EventSource | null = null;
    let pollId: number | null = null;

    const fetchQuotes = async () => {
      try {
        const res = await fetch(
          `${apiBase}/api/quotes?symbols=${encodeURIComponent(symbols)}&ext=${extEnabled ? "1" : "0"}`,
          { signal: controller.signal }
        );
        if (res.status === 401) {
          window.localStorage.removeItem(AUTH_TOKEN_KEY);
          setAuthToken("");
          setSyncState("local");
          setSessionAuthorized(false);
          setAuthChecked(true);
          setShowLogin(true);
          return;
        }
        if (!res.ok) throw new Error("quote fetch failed");
        const json = (await res.json()) as QuotesApiResponse;
        if (!active) return;
        const mapped: Record<string, Quote> = {};
        Object.entries(json.quotes || {}).forEach(([symbol, quote]) => {
          if (quote.price == null) return;
          mapped[symbol] = {
            price: Number(quote.price),
            change: Number(quote.change ?? 0),
            changePct: Number(quote.change_pct ?? 0),
            spark: quote.spark || [],
            exchange: quote.exchange || "",
            name: quote.name || "",
            currency: quote.currency || "",
            session: quote.session || "",
            lastTs: quote.last_ts ?? undefined,
            rthPrice: quote.rth_price != null ? Number(quote.rth_price) : undefined,
            rthChange: quote.rth_change != null ? Number(quote.rth_change) : undefined,
            rthChangePct: quote.rth_change_pct != null ? Number(quote.rth_change_pct) : undefined,
            extPrice: quote.ext_price != null ? Number(quote.ext_price) : undefined,
            extChange: quote.ext_change != null ? Number(quote.ext_change) : undefined,
            extChangePct: quote.ext_change_pct != null ? Number(quote.ext_change_pct) : undefined,
          };
        });
        setQuotesStale(Boolean(json.stale));
        setQuotes((prev) => ({ ...prev, ...mapped }));
      } catch {
        if (!controller.signal.aborted) {
          setQuotesStale(true);
          setQuotes((prev) => ({ ...prev }));
        }
      }
    };

    fetchQuotes();
    if (typeof EventSource !== "undefined") {
      eventSource = new EventSource(
        `${apiBase}/api/stream/quotes?symbols=${encodeURIComponent(
          symbols
        )}&ext=${extEnabled ? "1" : "0"}`
      );
      eventSource.onmessage = (event) => {
        if (!active) return;
        try {
          const json = JSON.parse(event.data) as QuotesApiResponse;
          const mapped: Record<string, Quote> = {};
          Object.entries(json.quotes || {}).forEach(([symbol, quote]) => {
            if (quote.price == null) return;
            mapped[symbol] = {
              price: Number(quote.price),
              change: Number(quote.change ?? 0),
              changePct: Number(quote.change_pct ?? 0),
              spark: quote.spark || [],
              exchange: quote.exchange || "",
              name: quote.name || "",
              currency: quote.currency || "",
              session: quote.session || "",
              lastTs: quote.last_ts ?? undefined,
              rthPrice: quote.rth_price != null ? Number(quote.rth_price) : undefined,
              rthChange: quote.rth_change != null ? Number(quote.rth_change) : undefined,
              rthChangePct: quote.rth_change_pct != null ? Number(quote.rth_change_pct) : undefined,
              extPrice: quote.ext_price != null ? Number(quote.ext_price) : undefined,
              extChange: quote.ext_change != null ? Number(quote.ext_change) : undefined,
              extChangePct: quote.ext_change_pct != null ? Number(quote.ext_change_pct) : undefined,
            };
          });
          setQuotesStale(Boolean(json.stale));
          setQuotes((prev) => ({ ...prev, ...mapped }));
        } catch {
          // Ignore malformed SSE payloads.
        }
      };
      eventSource.onerror = () => {
        setQuotesStale(true);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (!pollId) {
          pollId = window.setInterval(fetchQuotes, 15000);
        }
      };
    } else {
      pollId = window.setInterval(fetchQuotes, 15000);
    }
    return () => {
      active = false;
      controller.abort();
      if (eventSource) {
        eventSource.close();
      }
      if (pollId) {
        window.clearInterval(pollId);
      }
    };
  }, [apiBase, watchlist, watchlistKey, accessLocked]);

  const formatPrice = useCallback((value?: number) => {
    if (value === undefined || Number.isNaN(value)) return "--";
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }, []);

  const formatSigned = useCallback((value?: number, suffix = "") => {
    if (value === undefined || Number.isNaN(value)) return "--";
    const sign = value > 0 ? "+" : value < 0 ? "" : "";
    return `${sign}${value.toFixed(2)}${suffix}`;
  }, []);

  const formatAgeShort = useCallback((seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  }, []);

  const formatNewsTimestamp = useCallback((value?: string) => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return (
      parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
        hour12: true,
      }) + " ET"
    );
  }, []);

  const formatCountdown = useCallback((seconds: number) => {
    const clamped = Math.max(0, Math.floor(seconds));
    const hh = Math.floor(clamped / 3600);
    const mm = Math.floor((clamped % 3600) / 60);
    const ss = clamped % 60;
    if (hh > 0) {
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(
        ss
      ).padStart(2, "0")}`;
    }
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }, []);

  const getLatestIndicatorValue = useCallback((points: LinePoint[]) => {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const value = points[i]?.value;
      if (value != null && !Number.isNaN(value)) {
        return value;
      }
    }
    return null;
  }, []);

  const indicatorLegend = useMemo(() => {
    const items: { id: string; label: string; color: string; value: number | null }[] =
      [];
    const hasSma20 = indicatorData.sma20.length > 1;
    const hasSma50 = indicatorData.sma50.length > 1;
    const hasSma200 = indicatorData.sma200.length > 1;
    const hasEma12 = indicatorData.ema12.length > 1;
    const hasEma26 = indicatorData.ema26.length > 1;
    const hasRsi = indicatorData.rsi14.length > 1;
    const hasVwap = indicatorData.vwap.length > 1;

    if (showSma20 && hasSma20) {
      items.push({
        id: "sma20",
        label: "SMA20",
        color: "#3cc4ff",
        value: getLatestIndicatorValue(indicatorData.sma20),
      });
    }
    if (showSma50 && hasSma50) {
      items.push({
        id: "sma50",
        label: "SMA50",
        color: "#ffb454",
        value: getLatestIndicatorValue(indicatorData.sma50),
      });
    }
    if (showSma200 && hasSma200) {
      items.push({
        id: "sma200",
        label: "SMA200",
        color: "#6a7a73",
        value: getLatestIndicatorValue(indicatorData.sma200),
      });
    }
    if (showEma12 && hasEma12) {
      items.push({
        id: "ema12",
        label: "EMA12",
        color: "#00d084",
        value: getLatestIndicatorValue(indicatorData.ema12),
      });
    }
    if (showEma26 && hasEma26) {
      items.push({
        id: "ema26",
        label: "EMA26",
        color: "#ff5a5f",
        value: getLatestIndicatorValue(indicatorData.ema26),
      });
    }
    if (showVwap && hasVwap) {
      items.push({
        id: "vwap",
        label: "VWAP",
        color: "#7aa2ff",
        value: getLatestIndicatorValue(indicatorData.vwap),
      });
    }
    if (showRsi && hasRsi) {
      items.push({
        id: "rsi",
        label: "RSI14",
        color: "#f97316",
        value: getLatestIndicatorValue(indicatorData.rsi14),
      });
    }
    return items;
  }, [
    getLatestIndicatorValue,
    indicatorData,
    showSma20,
    showSma50,
    showSma200,
    showEma12,
    showEma26,
    showRsi,
    showVwap,
  ]);

  const indicatorCount = useMemo(
    () => indicatorLegend.length,
    [indicatorLegend.length]
  );
  const visibleIndicatorLegend = useMemo(
    () => indicatorLegend.slice(0, 4),
    [indicatorLegend]
  );
  const hiddenIndicatorCount = Math.max(0, indicatorLegend.length - visibleIndicatorLegend.length);
  const chartLastTs = useMemo(() => {
    const lastMain =
      candles.length > 0 ? Number(candles[candles.length - 1].time) : 0;
    const lastExt =
      extEnabled && extCandles.length > 0
        ? Number(extCandles[extCandles.length - 1].time)
        : 0;
    const chartTs = Math.max(lastMain, lastExt);
    if (chartTs > 0) return chartTs;
    return selectedQuote?.lastTs || 0;
  }, [candles, extCandles, extEnabled, selectedQuote?.lastTs]);

  const freshnessLabel = useMemo(() => {
    if (!chartLastTs) return "Last bar --";
    const age = Math.max(0, Math.floor(clockTs / 1000 - chartLastTs));
    return `Last bar ${formatAgeShort(age)} ago`;
  }, [chartLastTs, clockTs, formatAgeShort]);

  const candleCountdownLabel = useMemo(() => {
    const intervalSec = TIMEFRAME_SECONDS[timeframe] ?? 3600;
    if (!chartLastTs) return "Next --:--";
    const nowSec = Math.floor(clockTs / 1000);
    let nextBarTs = chartLastTs + intervalSec;
    if (nextBarTs < nowSec) {
      const barsBehind = Math.floor((nowSec - chartLastTs) / intervalSec);
      nextBarTs = chartLastTs + (barsBehind + 1) * intervalSec;
    }
    const remaining = Math.max(0, nextBarTs - nowSec);
    return `Next ${formatCountdown(remaining)}`;
  }, [chartLastTs, clockTs, formatCountdown, timeframe]);

  const watchlistLastQuoteTs = useMemo(() => {
    let latest = 0;
    for (const symbol of watchlist) {
      const ts = quotes[symbol]?.lastTs;
      if (typeof ts === "number" && ts > latest) latest = ts;
    }
    return latest;
  }, [quotes, watchlist]);

  const watchlistFreshnessLabel = useMemo(() => {
    if (!watchlistLastQuoteTs) return "Upd --";
    const age = Math.max(0, Math.floor(clockTs / 1000 - watchlistLastQuoteTs));
    return `Upd ${formatAgeShort(age)} ago`;
  }, [clockTs, formatAgeShort, watchlistLastQuoteTs]);


  useEffect(() => {
    watchlistLayoutRef.current = watchlistLayout;
  }, [watchlistLayout]);

  const startWatchlistResize = useCallback((handle: "items" | "selected") => {
    activeWatchlistHandleRef.current = handle;
  }, []);

  const stopWatchlistResize = useCallback(() => {
    activeWatchlistHandleRef.current = null;
  }, []);

  const applyWatchlistResize = useCallback((clientY: number) => {
    if (!activeWatchlistHandleRef.current) return;

    const section = watchlistSectionRef.current;
    if (!section) return;

    const rect = section.getBoundingClientRect();
    if (!rect.height) return;

    const pointerPercent = ((clientY - rect.top) / rect.height) * 100;
    const current = watchlistLayoutRef.current;

    if (activeWatchlistHandleRef.current === "items") {
      const nextItems = clampPercent(
        pointerPercent,
        WATCHLIST_LAYOUT_MIN_ITEMS,
        100 - WATCHLIST_LAYOUT_MIN_SELECTED - WATCHLIST_LAYOUT_MIN_NEWS
      );
      const nextSelected = clampPercent(
        100 - nextItems - current.news,
        WATCHLIST_LAYOUT_MIN_SELECTED,
        100 - nextItems - WATCHLIST_LAYOUT_MIN_NEWS
      );
      const nextNews = 100 - nextItems - nextSelected;
      if (
        current.items !== nextItems ||
        current.selected !== nextSelected ||
        current.news !== nextNews
      ) {
        setWatchlistLayout({ items: nextItems, selected: nextSelected, news: nextNews });
      }
      return;
    }

    const nextSelected = clampPercent(
      pointerPercent - current.items,
      WATCHLIST_LAYOUT_MIN_SELECTED,
      100 - current.items - WATCHLIST_LAYOUT_MIN_NEWS
    );
    const nextNews = 100 - current.items - nextSelected;

    if (
      current.selected !== nextSelected ||
      current.news !== nextNews
    ) {
      setWatchlistLayout({
        items: current.items,
        selected: nextSelected,
        news: nextNews,
      });
    }
  }, []);

  useEffect(() => {
    const onMouseMove = (ev: globalThis.MouseEvent) => {
      if (!activeWatchlistHandleRef.current) return;
      applyWatchlistResize(ev.clientY);
    };

    const onTouchMove = (ev: globalThis.TouchEvent) => {
      const touch = ev.touches[0];
      if (!touch || !activeWatchlistHandleRef.current) return;
      applyWatchlistResize(touch.clientY);
    };

    const onMouseUp = () => {
      stopWatchlistResize();
    };

    const onTouchEnd = () => {
      stopWatchlistResize();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [applyWatchlistResize, stopWatchlistResize]);


  useEffect(() => {
    const controller = new AbortController();
    const requestKey = `${selected}|${timeframe}|${extEnabled ? "1" : "0"}`;
    const requestSeq = fullFetchSeqRef.current + 1;
    fullFetchSeqRef.current = requestSeq;

    const run = async () => {
      if (accessLocked) {
        setIsLoading(false);
        setError("Sign in required to load chart data.");
        return;
      }
      if (!selected) {
        setIsLoading(false);
        setError(null);
        return;
      }
      defaultViewRef.current = true;
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/data/${encodeURIComponent(selected)}?tf=${encodeURIComponent(
            timeframe
          )}&ext=${extEnabled ? "1" : "0"}`,
          {
            signal: controller.signal,
            headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
          }
        );
        if (!res.ok) {
          if (res.status === 401) {
            window.localStorage.removeItem(AUTH_TOKEN_KEY);
            setAuthToken("");
            setSyncState("local");
            setSessionAuthorized(false);
            setAuthChecked(true);
            setShowLogin(true);
            throw new Error("Sign in required to load chart data.");
          }
          throw new Error(`No data for ${selected}`);
        }
        const json = await res.json();
        if (controller.signal.aborted || requestSeq !== fullFetchSeqRef.current) {
          return;
        }
        const nextCandlesRaw = sanitizeCandles(
          (json.candles || [])
            .map((item: Candle) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: Candle, b: Candle) => a.time - b.time)
        );
        const nextExtRaw = sanitizeCandles(
          (json.ext_candles || [])
            .map((item: Candle) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: Candle, b: Candle) => a.time - b.time)
        );
        const nextCandles = filterUnconfirmedSpikeCandles(nextCandlesRaw);
        const nextExt = filterUnconfirmedSpikeCandles(nextExtRaw);
        const nextVolume = (json.volume || [])
          .map((item: VolumePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: VolumePoint, b: VolumePoint) => a.time - b.time);
        const nextIndicators = {
          sma20: (json.indicators?.sma20 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          sma50: (json.indicators?.sma50 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          sma200: (json.indicators?.sma200 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          ema12: (json.indicators?.ema12 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          ema26: (json.indicators?.ema26 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          rsi14: (json.indicators?.rsi14 || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
          vwap: (json.indicators?.vwap || [])
            .map((item: LinePoint) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        };
        setCandles(nextCandles);
        candlesRef.current = nextCandles;
        setExtCandles(nextExt);
        extCandlesRef.current = nextExt;
        setIndicatorData({
          sma20: nextIndicators.sma20,
          sma50: nextIndicators.sma50,
          sma200: nextIndicators.sma200,
          ema12: nextIndicators.ema12,
          ema26: nextIndicators.ema26,
          rsi14: nextIndicators.rsi14,
          vwap: nextIndicators.vwap,
        });
        setVolumeData(nextVolume);
        lastLoadedDataKeyRef.current = requestKey;
        if (nextCandles.length === 0 && nextExt.length === 0) {
          setError("No data available for this symbol/timeframe.");
        }
      } catch (err) {
        if (controller.signal.aborted || requestSeq !== fullFetchSeqRef.current) {
          return;
        }
        const hasExisting =
          candlesRef.current.length > 0 || extCandlesRef.current.length > 0;
        const sameContext = lastLoadedDataKeyRef.current === requestKey;
        if (!hasExisting || !sameContext) {
          setCandles([]);
          candlesRef.current = [];
          setExtCandles([]);
          extCandlesRef.current = [];
          setIndicatorData({
            sma20: [],
            sma50: [],
            sma200: [],
            ema12: [],
            ema26: [],
            rsi14: [],
            vwap: [],
          });
          setVolumeData([]);
        }
        setError(
          hasExisting && sameContext
            ? "Data delayed: reconnecting..."
            : err instanceof Error
            ? err.message
            : "Data fetch failed"
        );
      } finally {
        if (!controller.signal.aborted && requestSeq === fullFetchSeqRef.current) {
          setIsLoading(false);
        }
      }
    };
    run();
    return () => {
      controller.abort();
    };
  }, [apiBase, selected, timeframe, extEnabled, authToken, accessLocked]);

  useEffect(() => {
    if (accessLocked) return;
    if (!watchlist.length) return;
    const symbols = Array.from(new Set([selected, ...watchlist].filter(Boolean)));
    const timer = window.setTimeout(() => {
      fetch(
        `${apiBase}/api/prewarm?symbols=${encodeURIComponent(
          symbols.join(",")
        )}&tf=${encodeURIComponent(timeframe)}&ext=${extEnabled ? "1" : "0"}`
      ).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [apiBase, selected, watchlist, watchlistKey, timeframe, extEnabled, accessLocked]);

  useEffect(() => {
    if (accessLocked) {
      setStreamMode("polling");
      return;
    }
    if (!selected) return;
    const pollMsByTf: Record<string, number> = {
      "1m": 3000,
      "5m": 5000,
      "15m": 8000,
      "30m": 12000,
      "1h": 15000,
      "4h": 20000,
      "1d": 30000,
      "1w": 45000,
    };
    const pollMs = pollMsByTf[timeframe] ?? 15000;
    let alive = true;
    let inflight = false;
    let pollId: number | null = null;
    let source: EventSource | null = null;
    let reconnectId: number | null = null;

    const applyDelta = (json: DeltaPayload) => {
      const incomingCandles = sanitizeCandles(
        (json.candles || [])
          .map((item: Candle) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: Candle, b: Candle) => a.time - b.time)
      );
      const incomingExt = sanitizeCandles(
        (json.ext_candles || [])
          .map((item: Candle) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: Candle, b: Candle) => a.time - b.time)
      );
      const incomingVolume = (json.volume || [])
        .map((item: VolumePoint) => ({
          ...item,
          time: toUtcTimestamp(Number(item.time)),
        }))
        .slice()
        .sort((a: VolumePoint, b: VolumePoint) => a.time - b.time);
      const incomingIndicators = {
        sma20: (json.indicators?.sma20 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        sma50: (json.indicators?.sma50 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        sma200: (json.indicators?.sma200 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        ema12: (json.indicators?.ema12 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        ema26: (json.indicators?.ema26 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        rsi14: (json.indicators?.rsi14 || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
        vwap: (json.indicators?.vwap || [])
          .map((item: LinePoint) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: LinePoint, b: LinePoint) => a.time - b.time),
      };
      const hasAny =
        incomingCandles.length > 0 ||
        incomingExt.length > 0 ||
        incomingVolume.length > 0 ||
        incomingIndicators.sma20.length > 0 ||
        incomingIndicators.sma50.length > 0 ||
        incomingIndicators.sma200.length > 0 ||
        incomingIndicators.ema12.length > 0 ||
        incomingIndicators.ema26.length > 0 ||
        incomingIndicators.rsi14.length > 0 ||
        incomingIndicators.vwap.length > 0;
      if (!hasAny) return;
      setError(null);
      if (incomingCandles.length) {
        setCandles((prev) => {
          const merged = mergeByTime(prev, incomingCandles);
          const filtered = filterUnconfirmedSpikeCandles(merged);
          candlesRef.current = filtered;
          return filtered;
        });
      }
      if (incomingExt.length) {
        setExtCandles((prev) => {
          const merged = mergeByTime(prev, incomingExt);
          const filtered = filterUnconfirmedSpikeCandles(merged);
          extCandlesRef.current = filtered;
          return filtered;
        });
      }
      if (incomingVolume.length) {
        setVolumeData((prev) => mergeByTime(prev, incomingVolume));
      }
      setIndicatorData((prev) => ({
        sma20: mergeByTime(prev.sma20, incomingIndicators.sma20),
        sma50: mergeByTime(prev.sma50, incomingIndicators.sma50),
        sma200: mergeByTime(prev.sma200, incomingIndicators.sma200),
        ema12: mergeByTime(prev.ema12, incomingIndicators.ema12),
        ema26: mergeByTime(prev.ema26, incomingIndicators.ema26),
        rsi14: mergeByTime(prev.rsi14, incomingIndicators.rsi14),
        vwap: mergeByTime(prev.vwap, incomingIndicators.vwap),
      }));
    };

    const runDeltaFetch = async () => {
      if (!alive || inflight || document.hidden) return;
      const lastMain = candlesRef.current.length
        ? Number(candlesRef.current[candlesRef.current.length - 1].time)
        : 0;
      const lastExt = extCandlesRef.current.length
        ? Number(extCandlesRef.current[extCandlesRef.current.length - 1].time)
        : 0;
      const since = Math.max(lastMain, lastExt);
      if (!since) return;
      inflight = true;
      try {
        const res = await fetch(
          `${apiBase}/api/data_delta/${encodeURIComponent(
            selected
          )}?tf=${encodeURIComponent(timeframe)}&ext=${
            extEnabled ? "1" : "0"
          }&since=${since}`
        );
        if (res.status === 401) {
          window.localStorage.removeItem(AUTH_TOKEN_KEY);
          setAuthToken("");
          setSyncState("local");
          setSessionAuthorized(false);
          setAuthChecked(true);
          setShowLogin(true);
          return;
        }
        if (!res.ok) return;
        const json = await res.json();
        applyDelta(json);
        setStreamMode((prev) => (prev === "reconnecting" ? "polling" : prev));
      } catch {
        // Silent fallback.
      } finally {
        inflight = false;
      }
    };

    const startPolling = () => {
      if (pollId) return;
      setStreamMode("polling");
      pollId = window.setInterval(runDeltaFetch, pollMs);
    };

    const stopPolling = () => {
      if (pollId) {
        window.clearInterval(pollId);
        pollId = null;
      }
    };

    const clearReconnect = () => {
      if (reconnectId) {
        window.clearInterval(reconnectId);
        reconnectId = null;
      }
    };

    const scheduleReconnect = () => {
      if (reconnectId) return;
      reconnectId = window.setInterval(() => {
        if (!alive || source || document.hidden) return;
        connectStream();
      }, 30000);
    };

    const connectStream = () => {
      if (!alive || source) return;
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      const lastMain = candlesRef.current.length
        ? Number(candlesRef.current[candlesRef.current.length - 1].time)
        : 0;
      const lastExt = extCandlesRef.current.length
        ? Number(extCandlesRef.current[extCandlesRef.current.length - 1].time)
        : 0;
      const since = Math.max(lastMain, lastExt);
      source = new EventSource(
        `${apiBase}/api/stream/data/${encodeURIComponent(
          selected
        )}?tf=${encodeURIComponent(timeframe)}&ext=${
          extEnabled ? "1" : "0"
        }&since=${since}`
      );
      source.onopen = () => {
        setStreamMode("stream");
        stopPolling();
        clearReconnect();
      };
      source.onmessage = (event) => {
        if (!alive) return;
        try {
          const json = JSON.parse(event.data);
          applyDelta(json);
        } catch {
          // Ignore malformed stream payload.
        }
      };
      source.onerror = () => {
        if (source) {
          source.close();
          source = null;
        }
        setStreamMode("reconnecting");
        startPolling();
        scheduleReconnect();
      };
    };

    setStreamMode("stream");
    connectStream();
    const visibilityHandler = () => {
      if (!document.hidden) {
        runDeltaFetch();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", visibilityHandler);
      stopPolling();
      clearReconnect();
      if (source) {
        source.close();
        source = null;
      }
    };
  }, [apiBase, selected, timeframe, extEnabled, accessLocked]);

  const renderSparkline = (values: number[] | undefined, color: string) => {
    if (!values || values.length < 2) {
      return <div className="sparkline empty" />;
    }
    const w = 48;
    const h = 18;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return (
      <svg className="sparkline" viewBox={`0 0 ${w} ${h}`}>
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="1"
          points={points.join(" ")}
        />
      </svg>
    );
  };


  const handleScreenshot = useCallback(() => {
    const chart = chartApiRef.current;
    if (!chart) return;
    const canvas = chart.takeScreenshot();
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `${selected || "chart"}-${timeframe}.png`;
    link.click();
  }, [selected, timeframe]);

  const handleFitData = useCallback(() => {
    chartApiRef.current?.timeScale().fitContent();
    chartApiRef.current?.priceScale("right").applyOptions({ autoScale: true });
    setChartMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const handleResetChartView = useCallback(() => {
    defaultViewRef.current = true;
    chartApiRef.current?.timeScale().resetTimeScale();
    chartApiRef.current?.timeScale().fitContent();
    chartApiRef.current?.priceScale("right").applyOptions({ autoScale: true });
    setChartMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const handleHideIndicators = useCallback(() => {
    setShowSma20(false);
    setShowSma50(false);
    setShowSma200(false);
    setShowEma12(false);
    setShowEma26(false);
    setShowVwap(false);
    setShowRsi(false);
    setShowVolume(false);
    setShowIndicatorPanel(false);
    setChartMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const handleChartsLogin = useCallback(async () => {
    setLoginError(null);
    const username = loginUsername.trim();
    const password = loginPassword;
    if (!username || !password) {
      setLoginError("Enter email/username and password");
      return;
    }
    try {
      setSyncState("syncing");
      const res = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncState("error");
        setLoginError(String((json as any).detail || "Login failed"));
        return;
      }
      const token = typeof (json as any).access_token === "string" ? (json as any).access_token : "";
      if (!token) {
        setSyncState("error");
        setLoginError("Login succeeded but no token returned");
        return;
      }
      window.localStorage.setItem(AUTH_TOKEN_KEY, token);
      setAuthToken(token);
      setSessionAuthorized(true);
      setAuthChecked(true);
      setLoginPassword("");
      setShowLogin(false);
    } catch {
      setSyncState("error");
      setLoginError("Login failed");
    }
  }, [apiBase, loginUsername, loginPassword]);

  const ohlcChange = ohlc ? ((ohlc.close - ohlc.open) / ohlc.open) * 100 : null;
  const ohlcUp = ohlc ? ohlc.close >= ohlc.open : null;

  const addSymbol = (raw: string) => {
    const symbol = normalizeSymbol(raw);
    if (!symbol) return;
    setWatchlist((prev) => {
      if (prev.includes(symbol)) {
        return prev;
      }
      const next = [...prev, symbol];
      if (next.length <= MAX_WATCHLIST) {
        return next;
      }
      return next.slice(next.length - MAX_WATCHLIST);
    });
    setSelected(symbol);
    setSearchQuery("");
    setSearchResults([]);
  };

  const removeSymbol = (symbol: string) => {
    setWatchlist((prev) => {
      const nextList = prev.filter((item) => item !== symbol);
      if (selected === symbol) {
        setSelected(nextList[0] || "");
      }
      return nextList;
    });
  };

  return (
    <div className="app-shell">
      <header className="tv-toolbar">
        <div className="tv-left">
          <div className="logo">
            <Image src="/whomp-logo.svg" alt="whomp logo" width={68} height={22} priority />
          </div>
          <div className="tv-headline">
            <div className="tv-symbol">
              <div className="tv-ticker">{selected || "--"}</div>
              <div className="tv-name-row">
                <span className="tv-name">{headerName || "—"}</span>
                {headerExchange !== "—" && <span className="tv-exchange">{headerExchange}</span>}
                {headerSession && headerSession !== "rth" && (
                  <span className="session-badge">{headerSession.toUpperCase()}</span>
                )}
              </div>
            </div>
            <div className="tv-price">
              <div className="tv-last">
                {headerPrice != null ? formatPrice(headerPrice) : "--"}
              </div>
              <div
                className={`tv-change ${
                  headerChange != null && headerChange !== 0
                    ? headerChange > 0
                      ? "change-up"
                      : "change-down"
                    : ""
                }`}
              >
                {headerChange != null ? formatSigned(headerChange, "%") : "--"}
              </div>
              <div className="tv-countdown" title="Time until next candle boundary.">
                {candleCountdownLabel}
              </div>
            </div>
          </div>
        </div>
        <div className="tv-center">
          {[...ADVANCED_TIMEFRAMES, ...CORE_TIMEFRAMES].map((tf) => (
            <button
              key={tf}
              className={`tf-pill ${timeframe === tf ? "active" : ""}`}
              onClick={() => setTimeframe(tf)}
            >
              {tf.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="tv-right">
          {!isEmbedMode && (
            <nav className="tv-app-nav" aria-label="Whomp sections">
              <a className="tv-app-link" href="https://whomp.ai/alphaai">
                Alpha AI
              </a>
              <a className="tv-app-link" href="https://whomp.ai/flow-tape">
                Flow Tape
              </a>
              <a className="tv-app-link" href="https://whomp.ai/news">
                The Wire
              </a>
              <a className="tv-app-link" href="https://whomp.ai/ticker/NVDA">
                Ticker Intel
              </a>
            </nav>
          )}
          <div className="tv-actions">
            <div className="indicator-control">
              <button
                className={`ind-panel-btn ${showIndicatorPanel ? "active" : ""}`}
                onClick={() => setShowIndicatorPanel((prev) => !prev)}
                title="Overlays and oscillators"
              >
                Indicators{indicatorCount > 0 ? ` (${indicatorCount})` : ""}
              </button>
              {showIndicatorPanel && (
                <div className="ind-panel">
                  <div className="ind-panel-title">Overlays</div>
                  <div className="ind-panel-grid">
                    <button
                      className={`ind-btn ${showSma20 ? "active" : ""} ${
                        indicatorData.sma20.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.sma20.length > 1
                          ? "SMA20"
                          : "Not enough data for SMA20"
                      }
                      onClick={() =>
                        indicatorData.sma20.length > 1 &&
                        setShowSma20((prev) => !prev)
                      }
                    >
                      SMA20
                    </button>
                    <button
                      className={`ind-btn ${showSma50 ? "active" : ""} ${
                        indicatorData.sma50.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.sma50.length > 1
                          ? "SMA50"
                          : "Not enough data for SMA50"
                      }
                      onClick={() =>
                        indicatorData.sma50.length > 1 &&
                        setShowSma50((prev) => !prev)
                      }
                    >
                      SMA50
                    </button>
                    <button
                      className={`ind-btn ${showSma200 ? "active" : ""} ${
                        indicatorData.sma200.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.sma200.length > 1
                          ? "SMA200"
                          : "Not enough data for SMA200"
                      }
                      onClick={() =>
                        indicatorData.sma200.length > 1 &&
                        setShowSma200((prev) => !prev)
                      }
                    >
                      SMA200
                    </button>
                    <button
                      className={`ind-btn ${showEma12 ? "active" : ""} ${
                        indicatorData.ema12.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.ema12.length > 1
                          ? "EMA12"
                          : "Not enough data for EMA12"
                      }
                      onClick={() =>
                        indicatorData.ema12.length > 1 &&
                        setShowEma12((prev) => !prev)
                      }
                    >
                      EMA12
                    </button>
                    <button
                      className={`ind-btn ${showEma26 ? "active" : ""} ${
                        indicatorData.ema26.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.ema26.length > 1
                          ? "EMA26"
                          : "Not enough data for EMA26"
                      }
                      onClick={() =>
                        indicatorData.ema26.length > 1 &&
                        setShowEma26((prev) => !prev)
                      }
                    >
                      EMA26
                    </button>
                    <button
                      className={`ind-btn ${showVwap ? "active" : ""} ${
                        indicatorData.vwap.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.vwap.length > 1
                          ? "VWAP"
                          : "Not enough data for VWAP"
                      }
                      onClick={() =>
                        indicatorData.vwap.length > 1 &&
                        setShowVwap((prev) => !prev)
                      }
                    >
                      VWAP
                    </button>
                    <button
                      className={`ind-btn ${showVolume ? "active" : ""}`}
                      onClick={() => setShowVolume((prev) => !prev)}
                    >
                      VOL
                    </button>
                  </div>
                  <div className="ind-panel-title">Oscillators</div>
                  <div className="ind-panel-grid">
                    <button
                      className={`ind-btn ${showRsi ? "active" : ""} ${
                        indicatorData.rsi14.length > 1 ? "" : "disabled"
                      }`}
                      title={
                        indicatorData.rsi14.length > 1
                          ? "RSI14"
                          : "Not enough data for RSI14"
                      }
                      onClick={() =>
                        indicatorData.rsi14.length > 1 &&
                        setShowRsi((prev) => !prev)
                      }
                    >
                      RSI
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              className={`ext-toggle toolbar-btn ${extEnabled ? "active" : ""}`}
              onClick={() => {
                const next = !extEnabled;
                setExtEnabled(next);
                window.sessionStorage.setItem("fv_ext_override", next ? "1" : "0");
              }}
            >
              EXT
            </button>
            <button className="snap-btn toolbar-btn" onClick={handleScreenshot}>
              Snapshot
            </button>
          </div>
          <div className="tv-status">
            <div className={`stream-pill ${streamMode}`}>
              {streamMode === "stream"
                ? "Live Delayed"
                : streamMode === "reconnecting"
                ? "Reconnecting…"
                : "Polling"}
            </div>
            <div className="freshness-pill" title="Chart bar freshness in delayed-live mode.">
              {freshnessLabel}
            </div>
            <div className="delay-pill" title="Free data source; delayed at least 10 minutes.">
              Delayed 10m+
            </div>
            <div className={`health-pill ${health}`}>{health}</div>
          </div>
        </div>
      </header>

      <div className={`main-container${isEmbedMode ? " embed-mode" : ""}${isCanvasOnly ? " embed-canvas" : ""}`}>
        <div className="chart-section">
          <div className="chart-header">
            <div className="chart-ohlc">
              {ohlc ? (
                <>
                  <span>O {formatPrice(ohlc.open)}</span>
                  <span>H {formatPrice(ohlc.high)}</span>
                  <span>L {formatPrice(ohlc.low)}</span>
                  <span>C {formatPrice(ohlc.close)}</span>
                  <span className={ohlcUp ? "change-up" : "change-down"}>
                    {ohlcChange != null ? formatSigned(ohlcChange, "%") : "--"}
                  </span>
                </>
              ) : (
                <span>Loading OHLC...</span>
              )}
            </div>
            <div className="chart-meta">
              <div className="chart-status">
                {isLoading ? "Loading..." : error ? error : "Ready"}
              </div>
              {indicatorLegend.length > 0 && (
                <div className="indicator-legend">
                  {visibleIndicatorLegend.map((item) => (
                    <div className="indicator-chip" key={item.id}>
                      <span
                        className="indicator-dot"
                        style={{ background: item.color }}
                      />
                      <span className="indicator-label">{item.label}</span>
                      <span className="indicator-value">
                        {item.value != null ? formatPrice(item.value) : "--"}
                      </span>
                    </div>
                  ))}
                  {hiddenIndicatorCount > 0 && (
                    <div className="indicator-chip indicator-more">
                      +{hiddenIndicatorCount} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div
            className={`chart-stage ${showRsi ? "with-rsi" : ""}`}
            onContextMenu={(event) => {
              event.preventDefault();
              const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
              const menuWidth = 182;
              const menuHeight = 118;
              const x = Math.min(
                Math.max(8, event.clientX - rect.left),
                Math.max(8, rect.width - menuWidth - 8)
              );
              const y = Math.min(
                Math.max(8, event.clientY - rect.top),
                Math.max(8, rect.height - menuHeight - 8)
              );
              setChartMenu({ open: true, x, y });
            }}
          >
            <div className="chart-container" ref={chartRef} />
            <div
              className={`rsi-container ${showRsi ? "active" : ""}`}
              ref={rsiChartRef}
            />
            {chartMenu.open && (
              <div
                className="chart-context-menu"
                style={{ left: chartMenu.x, top: chartMenu.y }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <button className="chart-context-item" onClick={handleResetChartView}>
                  Reset Chart
                </button>
                <button className="chart-context-item" onClick={handleFitData}>
                  Fit Data
                </button>
                <button className="chart-context-item" onClick={handleHideIndicators}>
                  Hide Indicators
                </button>
              </div>
            )}
            {!isLoading && (error || (candles.length === 0 && extCandles.length === 0)) && (
              <div className="chart-empty">
                <div className="chart-empty-title">
                  {error || "No data available"}
                </div>
                <div className="chart-empty-subtitle">
                  Try a different timeframe or check the symbol.
                </div>
              </div>
            )}
          </div>
        </div>

        {!isEmbedMode && <aside className="watchlist-section" ref={watchlistSectionRef}>
          <div className="watchlist-header">
            <span className="watchlist-title">Watchlist</span>
            <div className="watchlist-meta">
              <div className="watchlist-title-meta">
                <span
                  className={"chart-chip watchlist-state " + (quotesStale ? "is-stale" : "is-live")}
                  title={
                    quotesStale
                      ? "Using cached quotes due to upstream delay/error."
                      : "Receiving delayed stream updates."
                  }
                >
                  {quotesStale ? "Stale" : "Live"}
                </span>
                <span
                  className="chart-chip watchlist-updated"
                  title={
                    watchlistLastQuoteTs
                      ? "Latest quote " + new Date(
                          watchlistLastQuoteTs * 1000
                        ).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: true,
                        })
                      : "No quote timestamp yet."
                  }
                >
                  {watchlistFreshnessLabel}
                </span>
              </div>
              {!sessionAuthorized ? (
                <button className="chart-chip watch-auth" onClick={() => setShowLogin(true)} title="Sign in to sync watchlist across devices">
                  Sign in
                </button>
              ) : null}
              <span className={"chart-chip watch-sync " + "watch-sync-" + syncState} title="Watchlist sync status">
                {syncState === "synced" ? "Synced" : syncState === "syncing" ? "Syncing" : syncState === "error" ? "Sync error" : "Local"}
              </span>
              <span className="chart-chip watchlist-count">{watchlist.length} Active</span>
            </div>
          </div>
          <div className="watchlist-controls">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const top = searchResults[0]?.symbol;
                  addSymbol(top || searchQuery);
                }
              }}
              placeholder="Search tickers (type 2+)"
            />
            <button
              className="watch-search"
              onClick={() => {
                const top = searchResults[0]?.symbol;
                addSymbol(top || searchQuery);
              }}
            >
              Go
            </button>
            <button className="watch-add" onClick={() => addSymbol(searchQuery)}>
              +
            </button>
          </div>
          <div className="watchlist-hint">
            Enter = add top result · + = add exact ticker
          </div>
          {searchResults.length > 0 && (
            <div className="search-results active">
              {searchResults.map((item) => (
                <button
                  key={`${item.symbol}-${item.exchange}`}
                  className="search-item"
                  type="button"
                  onClick={() => addSymbol(item.symbol)}
                  aria-label={`Add ${item.symbol} to watchlist`}
                >
                  <div className="search-main">
                    <div className="search-symbol">{item.symbol}</div>
                    <div className="search-name">{item.name}</div>
                  </div>
                  <div className="search-meta">
                    {[formatExchangeLabel(item.exchange, item.symbol), item.type].filter(Boolean).join(" · ")}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="watchlist-body">
            <div className="watchlist-items" style={{ flex: "0 0 " + watchlistLayout.items + "%" }}>
            {watchlist.map((symbol) => {
              const quote = quotes[symbol];
              const changeClass =
                quote && quote.change !== 0
                  ? quote.change > 0
                    ? "change-up"
                    : "change-down"
                  : "";
              const dotColor =
                quote && quote.change !== 0
                  ? quote.change > 0
                    ? "var(--up)"
                    : "var(--down)"
                  : "var(--text-secondary)";
              const sparkColor =
                quote && quote.change >= 0 ? "var(--up)" : "var(--down)";
              return (
                <div
                  key={symbol}
                  className={`watch-item ${symbol === selected ? "active" : ""}`}
                  onClick={() => setSelected(symbol)}
                >
                  <div className="watch-left">
                    <div className="sym-dot" style={{ background: dotColor }} />
                    <div className="sym-info">
                      <div className="sym-symbol">{symbol}</div>
                      <div className="sym-name">
                        {formatExchangeLabel(quote?.exchange, symbol)}
                      </div>
                    </div>
                  </div>
                  {renderSparkline(quote?.spark, sparkColor)}
                  <div className="sym-price">
                    <div className="sym-last">{formatPrice(quote?.price)}</div>
                    <div className={`sym-change ${changeClass}`}>
                      {quote ? formatSigned(quote.changePct, "%") : "--"}
                    </div>
                  </div>
                  <button
                    className="watch-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSymbol(symbol);
                    }}
                    aria-label={`Remove ${symbol} from watchlist`}
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
          <div className="watchlist-split-handle" role="separator" aria-orientation="horizontal" aria-label="Resize watchlist list and selected section" onMouseDown={(event) => { event.preventDefault(); startWatchlistResize("items"); }} onTouchStart={(event) => { event.preventDefault(); startWatchlistResize("items"); }} />
            <div className="watchlist-detail" style={{ flex: "0 0 " + watchlistLayout.selected + "%" }}>
            <div className="detail-head">
              <div>
                <div className="detail-label">Selected</div>
                <div className="detail-symbol">{selected || "--"}</div>
              </div>
              {selectedQuote?.session && selectedQuote.session !== "rth" && (
                <div className="detail-session">{selectedQuote.session.toUpperCase()}</div>
              )}
            </div>
            <div className="detail-rows">
              <div className="detail-row">
                <div className="detail-row-label">RTH</div>
                <div
                  className={`detail-row-price ${
                    detailRthChange != null && detailRthChange !== 0
                      ? detailRthChange > 0
                        ? "change-up"
                        : "change-down"
                      : ""
                  }`}
                >
                  {formatPrice(detailRthPrice)}
                </div>
                <div
                  className={`detail-row-pct ${
                    detailRthChangePct != null && detailRthChangePct !== 0
                      ? detailRthChangePct > 0
                        ? "change-up"
                        : "change-down"
                      : ""
                  }`}
                >
                  {detailRthChangePct != null
                    ? formatSigned(detailRthChangePct, "%")
                    : "--"}
                </div>
              </div>
              {showExtDetail && (
                <div className="detail-row detail-row-ext">
                  <div className="detail-row-label">{extDetailLabel}</div>
                  <div
                    className={`detail-row-price ${
                      detailExtChange != null && detailExtChange !== 0
                        ? detailExtChange > 0
                          ? "change-up"
                          : "change-down"
                        : ""
                    }`}
                  >
                    {formatPrice(detailExtPrice)}
                  </div>
                  <div
                    className={`detail-row-pct ${
                      detailExtChangePct != null && detailExtChangePct !== 0
                        ? detailExtChangePct > 0
                          ? "change-up"
                          : "change-down"
                        : ""
                    }`}
                  >
                    {detailExtChangePct != null
                      ? formatSigned(detailExtChangePct, "%")
                      : "--"}
                  </div>
                </div>
              )}
            </div>
            <div className="detail-exchange">
              {formatExchangeLabel(quotes[selected]?.exchange, selected)}
            </div>
            {selectedQuote?.lastTs && (
              <div className="detail-updated">
                Last update{" "}
                {new Date(selectedQuote.lastTs * 1000).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: "America/New_York",
                })}{" "}
                ET
              </div>
            )}
          </div>
          <div className="watchlist-split-handle" role="separator" aria-orientation="horizontal" aria-label="Resize selected and news section" onMouseDown={(event) => { event.preventDefault(); startWatchlistResize("selected"); }} onTouchStart={(event) => { event.preventDefault(); startWatchlistResize("selected"); }} />
            <div className="watchlist-news" style={{ flex: "0 0 " + watchlistLayout.news + "%" }}>
            <div className="detail-label">News</div>
            {newsError && (
              <div className="news-empty">{newsError}</div>
            )}
            {!newsError && newsItems.length === 0 && (
              <div className="news-empty">No headlines yet.</div>
            )}
            {!newsError &&
              newsItems.map((item, idx) => (
                <a
                  key={`${item.title}-${idx}`}
                  className="news-item"
                  href={item.url || "#"}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="news-title">{item.title}</div>
                  <div className="news-meta">
                    {item.source || "—"}
                    {item.time ? ` · ${formatNewsTimestamp(item.time)}` : ""}
                  </div>
                </a>
              ))}
            </div>
          </div>
        </aside>}

        {accessLocked && (
          <div className="charts-lock-overlay">
            <div className="charts-lock-card">
              <div className="charts-lock-title">Sign in required</div>
              <div className="charts-lock-subtitle">
                Charts are available to authenticated Whomp users. Your watchlist and selected
                ticker sync to your account after sign in.
              </div>
              <button className="charts-lock-cta" onClick={() => setShowLogin(true)}>
                Sign in to continue
              </button>
            </div>
          </div>
        )}

        {!isEmbedMode && showLogin && (
          <div className="charts-login-backdrop" onMouseDown={() => setShowLogin(false)}>
            <div className="charts-login-modal" onMouseDown={(e) => e.stopPropagation()}>
              <div className="charts-login-title">Sync Watchlist</div>
              <div className="charts-login-sub">Sign in to save your watchlist per user.</div>
              <div className="charts-login-grid">
                <label>
                  <span>Email or username</span>
                  <input value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="you@example.com" autoComplete="username" />
                </label>
                <label>
                  <span>Password</span>
                  <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} autoComplete="current-password" />
                </label>
              </div>
              {loginError && <div className="charts-login-error">{loginError}</div>}
              <div className="charts-login-actions">
                <button className="charts-login-cancel" onClick={() => setShowLogin(false)}>Cancel</button>
                <button className="charts-login-primary" onClick={handleChartsLogin}>Sign in</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
