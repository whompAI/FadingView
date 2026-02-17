"use client";

import Image from "next/image";
import React, {
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
const DEFAULT_WATCHLIST_WIDTH = 360;
const MIN_WATCHLIST_WIDTH = 320;
const MIN_CHART_WIDTH = 460;
const WATCHLIST_HANDLE_WIDTH = 14;
const DEFAULT_WATCHLIST_LIST_HEIGHT = 210;
const MIN_WATCHLIST_LIST_HEIGHT = 120;
const MIN_WATCHLIST_DETAIL_HEIGHT = 220;
const MIN_WATCHLIST_NEWS_HEIGHT = 100;
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
const EXCHANGE_LABEL_MAP: Record<string, string> = {
  NASDAQ: "NASDAQ",
  NMS: "NASDAQ",
  XNAS: "NASDAQ",
  XNMS: "NASDAQ",
  XNCM: "NASDAQ",
  NYSE: "NYSE",
  XNYS: "NYSE",
  NYQ: "NYSE",
  ARCA: "NYSE ARCA",
  ARCX: "NYSE ARCA",
  BATS: "CBOE",
  BZX: "CBOE",
  CBOE: "CBOE",
  IEX: "IEX",
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
  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const watchlistSectionRef = useRef<HTMLElement | null>(null);
  const watchlistItemsRef = useRef<HTMLDivElement | null>(null);
  const watchlistVsplitRef = useRef<HTMLDivElement | null>(null);
  const watchlistDetailRef = useRef<HTMLDivElement | null>(null);
  const watchlistNewsRef = useRef<HTMLDivElement | null>(null);
  const countdownBadgeRef = useRef<HTMLDivElement | null>(null);
  const watchlistResizeFrameRef = useRef<number | null>(null);
  const watchlistListResizeFrameRef = useRef<number | null>(null);
  const countdownBadgeFrameRef = useRef<number | null>(null);
  const watchlistResizeStateRef = useRef({
    active: false,
    startX: 0,
    pointerId: -1,
    startWidth: DEFAULT_WATCHLIST_WIDTH,
    minWidth: MIN_WATCHLIST_WIDTH,
    maxWidth: 0,
  });
  const watchlistListResizeStateRef = useRef({
    active: false,
    startY: 0,
    pointerId: -1,
    startHeight: DEFAULT_WATCHLIST_LIST_HEIGHT,
    minHeight: MIN_WATCHLIST_LIST_HEIGHT,
    maxHeight: 0,
  });
  const watchlistWidthRef = useRef<number>(DEFAULT_WATCHLIST_WIDTH);
  const watchlistListHeightRef = useRef<number>(DEFAULT_WATCHLIST_LIST_HEIGHT);
  const urlStateReadyRef = useRef<boolean>(false);
  const fullFetchSeqRef = useRef<number>(0);
  const lastLoadedDataKeyRef = useRef<string>("");

  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_WATCHLIST);
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
  const [selected, setSelected] = useState<string>(DEFAULT_WATCHLIST[0]);
  const [timeframe, setTimeframe] = useState<string>(DEFAULT_TIMEFRAME);
  const [extEnabled, setExtEnabled] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SymbolResult[]>([]);
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
  const [watchlistWidth, setWatchlistWidth] = useState<number>(DEFAULT_WATCHLIST_WIDTH);
  const [isResizingWatchlist, setIsResizingWatchlist] = useState<boolean>(false);
  const [watchlistListHeight, setWatchlistListHeight] = useState<number>(
    DEFAULT_WATCHLIST_LIST_HEIGHT
  );
  const [isResizingWatchlistList, setIsResizingWatchlistList] =
    useState<boolean>(false);
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
  const headerExchange = selectedQuote?.exchange;
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
  const accessLocked = authChecked && !sessionAuthorized;

  const normalizeSymbol = (value: string): string =>
    value.toUpperCase().trim().replace(/[^A-Z0-9=.\-^/]/g, "");

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
    watchlistWidthRef.current = watchlistWidth;
    if (watchlistSectionRef.current) {
      watchlistSectionRef.current.style.width = `${watchlistWidth}px`;
    }
  }, [watchlistWidth]);

  useEffect(() => {
    watchlistListHeightRef.current = watchlistListHeight;
    if (watchlistItemsRef.current) {
      watchlistItemsRef.current.style.height = `${watchlistListHeight}px`;
    }
  }, [watchlistListHeight]);

  const getWatchlistListMaxHeight = useCallback(() => {
    const section = watchlistSectionRef.current;
    const items = watchlistItemsRef.current;
    const split = watchlistVsplitRef.current;
    if (!section || !items) return MIN_WATCHLIST_LIST_HEIGHT;

    const sectionRect = section.getBoundingClientRect();
    const itemsRect = items.getBoundingClientRect();
    const topOffset = Math.max(0, Math.floor(itemsRect.top - sectionRect.top));
    const splitHeight = Math.max(
      8,
      Math.floor(split?.getBoundingClientRect().height || 12)
    );

    let minDetailHeight = MIN_WATCHLIST_DETAIL_HEIGHT;
    const detail = watchlistDetailRef.current;
    const news = watchlistNewsRef.current;
    if (detail && news) {
      const detailRect = detail.getBoundingClientRect();
      const newsRect = news.getBoundingClientRect();
      const fixedDetail = Math.max(0, Math.floor(newsRect.top - detailRect.top));
      minDetailHeight = Math.max(
        MIN_WATCHLIST_DETAIL_HEIGHT,
        fixedDetail + MIN_WATCHLIST_NEWS_HEIGHT
      );
    }

    return Math.max(
      MIN_WATCHLIST_LIST_HEIGHT,
      Math.floor(sectionRect.height - topOffset - splitHeight - minDetailHeight)
    );
  }, []);

  useEffect(() => {
    const clampWidth = () => {
      const container = mainContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const maxWidth = Math.max(
        MIN_WATCHLIST_WIDTH,
        Math.floor(rect.width - WATCHLIST_HANDLE_WIDTH - MIN_CHART_WIDTH)
      );
      const nextWidth = Math.max(MIN_WATCHLIST_WIDTH, Math.min(watchlistWidthRef.current, maxWidth));
      if (nextWidth !== watchlistWidthRef.current) {
        setWatchlistWidth(nextWidth);
        watchlistWidthRef.current = nextWidth;
      }
      container.style.setProperty("--watchlist-width", `${watchlistWidthRef.current}px`);
    };
    const id = window.setTimeout(clampWidth, 0);
    window.addEventListener("resize", clampWidth);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", clampWidth);
    };
  }, []);

  useEffect(() => {
    const clampListHeight = () => {
      const maxHeight = getWatchlistListMaxHeight();
      const nextHeight = Math.max(
        MIN_WATCHLIST_LIST_HEIGHT,
        Math.min(watchlistListHeightRef.current, maxHeight)
      );
      if (nextHeight !== watchlistListHeightRef.current) {
        setWatchlistListHeight(nextHeight);
        watchlistListHeightRef.current = nextHeight;
      }
    };
    const id = window.setTimeout(clampListHeight, 0);
    window.addEventListener("resize", clampListHeight);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", clampListHeight);
    };
  }, [getWatchlistListMaxHeight]);

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
  }, []);

  useEffect(() => {
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
        if (normalized.length) {
          setWatchlist(normalized);
          const sel = typeof json.selected_symbol === "string" ? json.selected_symbol : "";
          setSelected(sel && normalized.includes(sel) ? sel : normalized[0]);
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
  }, [apiBase, authToken]);

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
        setSelected(normalized);
        setWatchlist((prev) => {
          if (prev.includes(normalized)) return prev;
          return [normalized, ...prev].slice(0, MAX_WATCHLIST);
        });
      }
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
  }, []);

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
    window.localStorage.setItem("fv_watchlist", JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    if (!selected) return;
    window.localStorage.setItem("fv_selected", selected);
  }, [selected]);

  useEffect(() => {
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
  }, [apiBase, authToken, sessionAuthorized, watchlistKey, selected]);

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
        const url = `${apiBase}/api/news?symbol=${encodeURIComponent(selected)}&limit=3`;
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
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    chart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.2 },
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
    const updateCountdownBadgeFromChart = () => {
      const chartContainer = chartRef.current;
      const badge = countdownBadgeRef.current;
      if (!chartContainer || !badge) return;

      let latestCandle = candlesRef.current.length
        ? candlesRef.current[candlesRef.current.length - 1]
        : null;
      if (extEnabledRef.current && extCandlesRef.current.length > 0) {
        const extLast = extCandlesRef.current[extCandlesRef.current.length - 1];
        if (!latestCandle || Number(extLast.time) > Number(latestCandle.time)) {
          latestCandle = extLast;
        }
      }
      if (!latestCandle) {
        badge.style.opacity = "0";
        return;
      }

      const rect = chartContainer.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 16 || height < 16) {
        badge.style.opacity = "0";
        return;
      }

      const xCoord = chart.timeScale().timeToCoordinate(latestCandle.time as Time);
      const lowY = mainSeries.priceToCoordinate(latestCandle.low);
      const closeY = mainSeries.priceToCoordinate(latestCandle.close);
      const badgeRect = badge.getBoundingClientRect();
      const badgeWidth = Math.max(56, Math.round(badgeRect.width));
      const badgeHeight = Math.max(18, Math.round(badgeRect.height));
      const rawLeft = (xCoord ?? width - 70) - badgeWidth / 2;
      const rawTop = (lowY ?? closeY ?? height - badgeHeight - 12) + 12;
      const left = Math.max(8, Math.min(width - badgeWidth - 8, rawLeft));
      const top = Math.max(8, Math.min(height - badgeHeight - 8, rawTop));

      badge.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      badge.style.opacity = "1";
    };

    const scheduleCountdownBadgeFromChart = () => {
      if (countdownBadgeFrameRef.current != null) return;
      countdownBadgeFrameRef.current = window.requestAnimationFrame(() => {
        countdownBadgeFrameRef.current = null;
        updateCountdownBadgeFromChart();
      });
    };

    const onVisibleRangeChange = () => {
      scheduleCountdownBadgeFromChart();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleRangeChange);

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
        window.cancelAnimationFrame(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.requestAnimationFrame(() => {
        resizeTimerRef.current = null;
        if (!chartRef.current) return;
        const rect = chartRef.current.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width < 10 || height < 10) {
          return;
        }
        if (
          lastSizeRef.current.width === width &&
          lastSizeRef.current.height === height
        ) {
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
        scheduleCountdownBadgeFromChart();
      });
    };
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(chartRef.current);
    if (rsiChartRef.current) {
      resizeObserver.observe(rsiChartRef.current);
    }
    window.addEventListener("resize", handleResize);
    const rafId = window.requestAnimationFrame(() => {
      handleResize();
      scheduleCountdownBadgeFromChart();
    });

    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      if (resizeTimerRef.current) {
        window.cancelAnimationFrame(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (syncRange) {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncRange);
      }
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange);
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
          `${apiBase}/api/quotes?symbols=${encodeURIComponent(symbols)}&ext=1`,
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
        )}&ext=1`
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

  const formatExchangeLabel = useCallback((value?: string) => {
    const next = (value || "").trim().toUpperCase();
    if (!next) return "—";
    return EXCHANGE_LABEL_MAP[next] || next;
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

  const updateCountdownBadgePosition = useCallback(() => {
    const chart = chartApiRef.current;
    const mainSeries = seriesRef.current;
    const chartContainer = chartRef.current;
    const badge = countdownBadgeRef.current;
    if (!chart || !mainSeries || !chartContainer || !badge) return;

    let latestCandle = candlesRef.current.length
      ? candlesRef.current[candlesRef.current.length - 1]
      : null;
    if (extEnabledRef.current && extCandlesRef.current.length > 0) {
      const extLast = extCandlesRef.current[extCandlesRef.current.length - 1];
      if (!latestCandle || Number(extLast.time) > Number(latestCandle.time)) {
        latestCandle = extLast;
      }
    }
    if (!latestCandle) {
      badge.style.opacity = "0";
      return;
    }

    const rect = chartContainer.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 16 || height < 16) {
      badge.style.opacity = "0";
      return;
    }

    const xCoord = chart.timeScale().timeToCoordinate(latestCandle.time as Time);
    const lowY = mainSeries.priceToCoordinate(latestCandle.low);
    const closeY = mainSeries.priceToCoordinate(latestCandle.close);
    const badgeRect = badge.getBoundingClientRect();
    const badgeWidth = Math.max(56, Math.round(badgeRect.width));
    const badgeHeight = Math.max(18, Math.round(badgeRect.height));
    const rawLeft = (xCoord ?? width - 70) - badgeWidth / 2;
    const rawTop = (lowY ?? closeY ?? height - badgeHeight - 12) + 12;
    const left = Math.max(8, Math.min(width - badgeWidth - 8, rawLeft));
    const top = Math.max(8, Math.min(height - badgeHeight - 8, rawTop));

    badge.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    badge.style.opacity = "1";
  }, []);

  const queueCountdownBadgePosition = useCallback(() => {
    if (countdownBadgeFrameRef.current != null) return;
    countdownBadgeFrameRef.current = window.requestAnimationFrame(() => {
      countdownBadgeFrameRef.current = null;
      updateCountdownBadgePosition();
    });
  }, [updateCountdownBadgePosition]);

  const applyWatchlistWidthCssVar = useCallback((width: number) => {
    if (!mainContainerRef.current) return;
    mainContainerRef.current.style.setProperty("--watchlist-width", `${width}px`);
  }, []);

  const applyWatchlistResize = useCallback((clientX: number) => {
    const state = watchlistResizeStateRef.current;
    if (!state.active) return;
    const delta = clientX - state.startX;
    const nextWidth = Math.max(
      state.minWidth,
      Math.min(state.maxWidth, Math.round(state.startWidth - delta))
    );
    if (nextWidth === watchlistWidthRef.current) return;
    watchlistWidthRef.current = nextWidth;
    if (watchlistResizeFrameRef.current != null) return;
    watchlistResizeFrameRef.current = window.requestAnimationFrame(() => {
      watchlistResizeFrameRef.current = null;
      applyWatchlistWidthCssVar(watchlistWidthRef.current);
    });
  }, [applyWatchlistWidthCssVar]);

  const stopWatchlistResize = useCallback(() => {
    const state = watchlistResizeStateRef.current;
    if (!state.active) return;
    state.active = false;
    state.pointerId = -1;
    setIsResizingWatchlist(false);
    if (watchlistResizeFrameRef.current != null) {
      window.cancelAnimationFrame(watchlistResizeFrameRef.current);
      watchlistResizeFrameRef.current = null;
    }
    applyWatchlistWidthCssVar(watchlistWidthRef.current);
    setWatchlistWidth(watchlistWidthRef.current);
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("cursor");
  }, [applyWatchlistWidthCssVar]);

  const startWatchlistResize = useCallback(
    (clientX: number, pointerId: number) => {
      const container = mainContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const maxWidth = Math.max(
        MIN_WATCHLIST_WIDTH,
        Math.floor(rect.width - WATCHLIST_HANDLE_WIDTH - MIN_CHART_WIDTH)
      );
      const startWidth = Math.max(
        MIN_WATCHLIST_WIDTH,
        Math.min(watchlistWidthRef.current, maxWidth)
      );
      watchlistResizeStateRef.current = {
        active: true,
        startX: clientX,
        pointerId,
        startWidth,
        minWidth: MIN_WATCHLIST_WIDTH,
        maxWidth,
      };
      setWatchlistWidth(startWidth);
      watchlistWidthRef.current = startWidth;
      applyWatchlistWidthCssVar(startWidth);
      setIsResizingWatchlist(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [applyWatchlistWidthCssVar]
  );

  const onWatchlistPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      startWatchlistResize(event.clientX, event.pointerId);
    },
    [startWatchlistResize]
  );

  useEffect(() => {
    if (!isResizingWatchlist) return;

    const onPointerMove = (event: PointerEvent) => {
      const state = watchlistResizeStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      applyWatchlistResize(event.clientX);
    };

    const onPointerEnd = (event: PointerEvent) => {
      const state = watchlistResizeStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      stopWatchlistResize();
    };

    const onWindowBlur = () => {
      stopWatchlistResize();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [applyWatchlistResize, isResizingWatchlist, stopWatchlistResize]);

  const applyWatchlistListResize = useCallback((clientY: number) => {
    const state = watchlistListResizeStateRef.current;
    if (!state.active) return;
    const delta = clientY - state.startY;
    const nextHeight = Math.max(
      state.minHeight,
      Math.min(state.maxHeight, Math.round(state.startHeight + delta))
    );
    if (nextHeight === watchlistListHeightRef.current) return;
    watchlistListHeightRef.current = nextHeight;
    if (watchlistListResizeFrameRef.current != null) return;
    watchlistListResizeFrameRef.current = window.requestAnimationFrame(() => {
      watchlistListResizeFrameRef.current = null;
      if (watchlistItemsRef.current) {
        watchlistItemsRef.current.style.height = `${watchlistListHeightRef.current}px`;
      }
    });
  }, []);

  const onWatchlistListPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = watchlistListResizeStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      applyWatchlistListResize(event.clientY);
    },
    [applyWatchlistListResize]
  );

  const stopWatchlistListResize = useCallback(() => {
    const state = watchlistListResizeStateRef.current;
    if (!state.active) return;
    state.active = false;
    state.pointerId = -1;
    setIsResizingWatchlistList(false);
    if (watchlistListResizeFrameRef.current != null) {
      window.cancelAnimationFrame(watchlistListResizeFrameRef.current);
      watchlistListResizeFrameRef.current = null;
    }
    if (watchlistItemsRef.current) {
      watchlistItemsRef.current.style.height = `${watchlistListHeightRef.current}px`;
    }
    setWatchlistListHeight(watchlistListHeightRef.current);
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("cursor");
  }, []);

  const startWatchlistListResize = useCallback(
    (clientY: number, pointerId: number) => {
      const section = watchlistSectionRef.current;
      if (!section) return;
      const maxHeight = getWatchlistListMaxHeight();
      const startHeight = Math.max(
        MIN_WATCHLIST_LIST_HEIGHT,
        Math.min(watchlistListHeightRef.current, maxHeight)
      );
      watchlistListResizeStateRef.current = {
        active: true,
        startY: clientY,
        pointerId,
        startHeight,
        minHeight: MIN_WATCHLIST_LIST_HEIGHT,
        maxHeight,
      };
      setWatchlistListHeight(startHeight);
      watchlistListHeightRef.current = startHeight;
      setIsResizingWatchlistList(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
    },
    [getWatchlistListMaxHeight]
  );

  const onWatchlistListPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      startWatchlistListResize(event.clientY, event.pointerId);
    },
    [startWatchlistListResize]
  );

  const onWatchlistListPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = watchlistListResizeStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopWatchlistListResize();
    },
    [stopWatchlistListResize]
  );

  const onWatchlistListPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = watchlistListResizeStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopWatchlistListResize();
    },
    [stopWatchlistListResize]
  );

  useEffect(() => () => {
    stopWatchlistResize();
  }, [stopWatchlistResize]);

  useEffect(() => () => {
    if (countdownBadgeFrameRef.current != null) {
      window.cancelAnimationFrame(countdownBadgeFrameRef.current);
      countdownBadgeFrameRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopWatchlistListResize();
  }, [stopWatchlistListResize]);

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

  useEffect(() => {
    queueCountdownBadgePosition();
  }, [
    queueCountdownBadgePosition,
    candleCountdownLabel,
    chartLastTs,
    timeframe,
    watchlistWidth,
    showRsi,
  ]);

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
            throw new Error("Chart feed requires sign-in.");
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
  }, [apiBase, selected, timeframe, extEnabled, authToken]);

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
    let streamWatchdogId: number | null = null;
    let lastStreamActivityTs = Date.now();
    let pollNoDataCount = 0;
    const streamWatchdogMs = 45000;

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
      if (hasAny) {
        lastStreamActivityTs = Date.now();
      }
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
          setError("Chart feed requires sign-in.");
          return;
        }
        if (!res.ok) return;
        const json = await res.json();
        applyDelta(json);
        if (
          (json?.candles && json.candles.length > 0) ||
          (json?.ext_candles && json.ext_candles.length > 0) ||
          (json?.volume && json.volume.length > 0)
        ) {
          pollNoDataCount = 0;
          setStreamMode((prev) => (prev === "reconnecting" ? "polling" : prev));
        } else {
          pollNoDataCount += 1;
          if (pollNoDataCount >= 8) {
            setStreamMode((prev) => (prev === "stream" ? "polling" : prev));
          }
        }
      } catch {
        // Silent fallback.
      } finally {
        inflight = false;
      }
    };

    const startPolling = () => {
      if (pollId) return;
      setStreamMode("polling");
      runDeltaFetch();
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

    const clearWatchdog = () => {
      if (streamWatchdogId) {
        window.clearInterval(streamWatchdogId);
        streamWatchdogId = null;
      }
    };

    const setWatchdog = () => {
      clearWatchdog();
      streamWatchdogId = window.setInterval(() => {
        if (!alive || !source || document.hidden) return;
        if (Date.now() - lastStreamActivityTs < streamWatchdogMs) return;
        if (source) {
          source.close();
          source = null;
        }
        setStreamMode("reconnecting");
        startPolling();
        scheduleReconnect();
      }, 10000);
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
        pollNoDataCount = 0;
        lastStreamActivityTs = Date.now();
        stopPolling();
        clearReconnect();
      };
      source.onmessage = (event) => {
        if (!alive) return;
        try {
          const json = JSON.parse(event.data);
          lastStreamActivityTs = Date.now();
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
      setWatchdog();
    };

    setStreamMode("stream");
    connectStream();
    const visibilityHandler = () => {
      if (!document.hidden) {
        lastStreamActivityTs = Date.now();
        runDeltaFetch();
        setWatchdog();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", visibilityHandler);
      stopPolling();
      clearWatchdog();
      clearReconnect();
      if (source) {
        source.close();
        source = null;
      }
    };
  }, [apiBase, selected, timeframe, extEnabled]);

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
  const headerExchangeLabel = formatExchangeLabel(headerExchange);
  const selectedExchangeLabel = formatExchangeLabel(selectedQuote?.exchange);

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
                {headerExchange && <span className="tv-exchange">{headerExchangeLabel}</span>}
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
          <nav className="tv-app-nav" aria-label="Whomp sections">
            <a
              className="tv-app-link"
              href="https://whomp.ai/alphaai"
              target="_top"
              rel="noreferrer"
            >
              Alpha AI
            </a>
            <a
              className="tv-app-link"
              href="https://whomp.ai/flow-tape"
              target="_top"
              rel="noreferrer"
            >
              Flow Tape
            </a>
            <a
              className="tv-app-link"
              href="https://whomp.ai/news"
              target="_top"
              rel="noreferrer"
            >
              The Wire
            </a>
            <a
              className="tv-app-link"
              href="https://whomp.ai/ticker/NVDA"
              target="_top"
              rel="noreferrer"
            >
              Ticker Intel
            </a>
          </nav>
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

      <div className="main-container" ref={mainContainerRef} data-watchlist-width={watchlistWidth}>
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
              ref={countdownBadgeRef}
              className="chart-candle-countdown"
              title="Time until next candle boundary."
            >
              {candleCountdownLabel}
            </div>
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

        <div
          className={`watchlist-resize-handle ${isResizingWatchlist ? "is-dragging" : ""}`}
          role="separator"
          aria-label="Resize watchlist panel"
          aria-orientation="vertical"
          onPointerDown={onWatchlistPointerDown}
        />

        <aside
          className="watchlist-section"
          ref={watchlistSectionRef}
        >
          <div className="watchlist-header">
            <span>Watchlist</span>
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
                    {[item.exchange, item.type].filter(Boolean).join(" · ")}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div
            className="watchlist-items"
            ref={watchlistItemsRef}
            style={{ height: `${watchlistListHeightRef.current}px` }}
          >
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
                        {quote ? formatExchangeLabel(quote.exchange) : "—"}
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
          <div
            className={`watchlist-vsplit-handle ${
              isResizingWatchlistList ? "is-dragging" : ""
            }`}
            ref={watchlistVsplitRef}
            role="separator"
            aria-label="Resize watchlist rows and details"
            aria-orientation="horizontal"
            onPointerDown={onWatchlistListPointerDown}
            onPointerMove={onWatchlistListPointerMove}
            onPointerUp={onWatchlistListPointerUp}
            onPointerCancel={onWatchlistListPointerCancel}
          />
          <div className="watchlist-detail" ref={watchlistDetailRef}>
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
              {selectedExchangeLabel}
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
          <div className="watchlist-news" ref={watchlistNewsRef}>
            <div className="detail-label">News</div>
            <div className="watchlist-news-scroll">
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
        </aside>

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

        {showLogin && (
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
