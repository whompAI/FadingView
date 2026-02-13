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

type CandleWire = Omit<Candle, "time"> & { time: number };
type LinePointWire = { time: number; value: number };
type VolumePointWire = { time: number; value: number; color?: string };

type DataSnapshotResponse = {
  candles?: CandleWire[];
  ext_candles?: CandleWire[];
  volume?: VolumePointWire[];
  indicators?: {
    sma20?: LinePointWire[];
    sma50?: LinePointWire[];
    sma200?: LinePointWire[];
    ema12?: LinePointWire[];
    ema26?: LinePointWire[];
    rsi14?: LinePointWire[];
    vwap?: LinePointWire[];
  };
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

type NewsApiItem = {
  title?: string;
  source?: string;
  published_at?: string;
  url?: string;
};

type NewsApiResponse = {
  data?: NewsApiItem[];
};

type EmbedConfig = {
  embed: boolean;
  chromeOff: boolean;
  mode: string;
  seed: string;
  canvasOnly: boolean;
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

const DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "NVDA", "MSFT"];
const CORE_TIMEFRAMES = ["1h", "4h", "1d", "1w"];
const ADVANCED_TIMEFRAMES = ["1m", "5m", "15m", "30m"];
const DEFAULT_TIMEFRAME = "1h";
const MAX_WATCHLIST = 50;
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
const MAX_BARS_BY_TF: Record<string, number> = {
  "1m": 900,
  "5m": 700,
  "15m": 600,
  "30m": 500,
  "1h": 500,
  "4h": 420,
  "1d": 320,
  "1w": 260,
};

export default function Home() {
  const apiBase = useMemo(
    () => process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000",
    []
  );
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
  const rthTimesRef = useRef<Set<number>>(new Set());
  const volumeDataRef = useRef<VolumePoint[]>([]);
  const indicatorDataRef = useRef<{
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
  const defaultViewRef = useRef<boolean>(true);
  const candlesRef = useRef<Candle[]>([]);
  const extCandlesRef = useRef<Candle[]>([]);
  const extEnabledRef = useRef<boolean>(false);
  const togglesRef = useRef<{
    showSma20: boolean;
    showSma50: boolean;
    showSma200: boolean;
    showEma12: boolean;
    showEma26: boolean;
    showVwap: boolean;
    showRsi: boolean;
    showVolume: boolean;
  }>({
    showSma20: false,
    showSma50: false,
    showSma200: false,
    showEma12: false,
    showEma26: false,
    showVwap: false,
    showRsi: false,
    showVolume: true,
  });
  const resizeTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const urlStateReadyRef = useRef<boolean>(false);
  const fullFetchSeqRef = useRef<number>(0);
  const lastLoadedDataKeyRef = useRef<string>("");

  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_WATCHLIST);
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
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesStale, setQuotesStale] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>("offline");
  const [streamMode, setStreamMode] = useState<"stream" | "reconnecting" | "polling">("stream");
  const [chartLastBarTs, setChartLastBarTs] = useState<number>(0);
  const [indicatorLast, setIndicatorLast] = useState<{
    sma20?: number;
    sma50?: number;
    sma200?: number;
    ema12?: number;
    ema26?: number;
    vwap?: number;
    rsi14?: number;
  }>({});
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
  const embedConfig = useMemo<EmbedConfig>(() => {
    if (typeof window === "undefined") {
      return { embed: false, chromeOff: false, mode: "", seed: "", canvasOnly: false };
    }

    const params = new URLSearchParams(window.location.search);
    const embed = params.get("embed") === "1";
    const chromeOff = params.get("chrome") === "0";
    const mode = (params.get("mode") || "").toLowerCase();
    const seed = params.get("seed") || "";
    const canvasOnly = embed && (chromeOff || mode === "canvas" || mode === "");

    return { embed, chromeOff, mode, seed, canvasOnly };
  }, []);

  const normalizeSymbol = (value: string): string =>
    value.toUpperCase().trim().replace(/[^A-Z0-9=.\-^/]/g, "");

  const embedSymbol = useMemo<string | null>(() => {
    if (!embedConfig.embed || typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const symbolParam = params.get("symbol");
    const normalized = normalizeSymbol(symbolParam ?? "");
    return normalized || null;
  }, [embedConfig.embed]);

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
    togglesRef.current = {
      showSma20,
      showSma50,
      showSma200,
      showEma12,
      showEma26,
      showVwap,
      showRsi,
      showVolume,
    };
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
    const storedWatchlist = window.localStorage.getItem("fv_watchlist");
    const storedSelected = window.localStorage.getItem("fv_selected");
    if (embedConfig.embed && embedSymbol) {
      setSelected(embedSymbol);
      setWatchlist((prev) => {
        if (prev.includes(embedSymbol)) return prev;
        return [embedSymbol, ...prev].slice(0, MAX_WATCHLIST);
      });
      return;
    }

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
    const symbolParam = embedSymbol || params.get("symbol");
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

  // Guardrail: embed mode is canonically driven by query symbol.
  useEffect(() => {
    if (!embedConfig.embed || !embedSymbol) return;
    if (selected !== embedSymbol) {
      setSelected(embedSymbol);
      setWatchlist((prev) => {
        if (prev.includes(embedSymbol)) return prev;
        return [embedSymbol, ...prev].slice(0, MAX_WATCHLIST);
      });
    }
  }, [embedConfig.embed, embedSymbol, selected]);

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
    if (!urlStateReadyRef.current || !selected) return;
    if (embedConfig.embed) return;

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
    if (!embedConfig.embed) return;

    const html = document.documentElement;
    html.classList.add("whomp-embed");

    return () => {
      html.classList.remove("whomp-embed");
    };
  }, [embedConfig.embed]);


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
    const key = process.env.NEXT_PUBLIC_MARKETAUX_KEY;
    if (!key) {
      setNewsItems([]);
      setNewsError("Add Marketaux API key to enable news.");
      return;
    }
    const controller = new AbortController();
    const fetchNews = async () => {
      try {
        const url = `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(
          selected
        )}&filter_entities=true&language=en&limit=3&api_token=${encodeURIComponent(
          key
        )}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("news fetch failed");
        const json = (await res.json()) as NewsApiResponse;
        const items = (json.data || [])
          .map((item: NewsApiItem) => ({
            title: (item.title || "").trim(),
            source: item.source,
            time: item.published_at,
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
    return () => controller.abort();
  }, [selected]);

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
    if (selected) return;
    seriesRef.current?.setData([]);
    extSeriesRef.current?.setData([]);
    volumeRef.current?.setData([]);
    sma20Ref.current?.setData([]);
    sma50Ref.current?.setData([]);
    sma200Ref.current?.setData([]);
    ema12Ref.current?.setData([]);
    ema26Ref.current?.setData([]);
    vwapRef.current?.setData([]);
    rsiSeriesRef.current?.setData([]);
    candlesRef.current = [];
    extCandlesRef.current = [];
    volumeDataRef.current = [];
    indicatorDataRef.current = {
      sma20: [],
      sma50: [],
      sma200: [],
      ema12: [],
      ema26: [],
      rsi14: [],
      vwap: [],
    };
    rthTimesRef.current = new Set();
    lastCandleRef.current = null;
    setOhlc(null);
    setChartLastBarTs(0);
    setIndicatorLast({});
  }, [selected]);

  useEffect(() => {
    volumeRef.current?.setData(showVolume ? volumeDataRef.current : []);
  }, [showVolume]);

  useEffect(() => {
    sma20Ref.current?.setData(showSma20 ? indicatorDataRef.current.sma20 : []);
  }, [showSma20]);

  useEffect(() => {
    sma50Ref.current?.setData(showSma50 ? indicatorDataRef.current.sma50 : []);
  }, [showSma50]);

  useEffect(() => {
    sma200Ref.current?.setData(showSma200 ? indicatorDataRef.current.sma200 : []);
  }, [showSma200]);

  useEffect(() => {
    ema12Ref.current?.setData(showEma12 ? indicatorDataRef.current.ema12 : []);
  }, [showEma12]);

  useEffect(() => {
    ema26Ref.current?.setData(showEma26 ? indicatorDataRef.current.ema26 : []);
  }, [showEma26]);

  useEffect(() => {
    vwapRef.current?.setData(showVwap ? indicatorDataRef.current.vwap : []);
  }, [showVwap]);

  useEffect(() => {
    rsiSeriesRef.current?.setData(showRsi ? indicatorDataRef.current.rsi14 : []);
  }, [showRsi]);

  useEffect(() => {
    if (!extSeriesRef.current) return;
    if (!extEnabled) {
      extSeriesRef.current.setData([]);
      return;
    }
    const filtered = extCandlesRef.current.filter(
      (bar) => !rthTimesRef.current.has(Number(bar.time))
    );
    extSeriesRef.current.setData(filtered);
  }, [extEnabled]);

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
  }, [apiBase, watchlist, watchlistKey]);

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
        value: indicatorLast.sma20 ?? getLatestIndicatorValue(indicatorData.sma20),
      });
    }
    if (showSma50 && hasSma50) {
      items.push({
        id: "sma50",
        label: "SMA50",
        color: "#ffb454",
        value: indicatorLast.sma50 ?? getLatestIndicatorValue(indicatorData.sma50),
      });
    }
    if (showSma200 && hasSma200) {
      items.push({
        id: "sma200",
        label: "SMA200",
        color: "#6a7a73",
        value: indicatorLast.sma200 ?? getLatestIndicatorValue(indicatorData.sma200),
      });
    }
    if (showEma12 && hasEma12) {
      items.push({
        id: "ema12",
        label: "EMA12",
        color: "#00d084",
        value: indicatorLast.ema12 ?? getLatestIndicatorValue(indicatorData.ema12),
      });
    }
    if (showEma26 && hasEma26) {
      items.push({
        id: "ema26",
        label: "EMA26",
        color: "#ff5a5f",
        value: indicatorLast.ema26 ?? getLatestIndicatorValue(indicatorData.ema26),
      });
    }
    if (showVwap && hasVwap) {
      items.push({
        id: "vwap",
        label: "VWAP",
        color: "#7aa2ff",
        value: indicatorLast.vwap ?? getLatestIndicatorValue(indicatorData.vwap),
      });
    }
    if (showRsi && hasRsi) {
      items.push({
        id: "rsi",
        label: "RSI14",
        color: "#f97316",
        value: indicatorLast.rsi14 ?? getLatestIndicatorValue(indicatorData.rsi14),
      });
    }
    return items;
  }, [
    getLatestIndicatorValue,
    indicatorData,
    indicatorLast,
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
    if (chartLastBarTs > 0) return chartLastBarTs;
    return selectedQuote?.lastTs || 0;
  }, [chartLastBarTs, selectedQuote?.lastTs]);

  const chartStatus = useMemo(() => {
    if (!chartLastTs) {
      return {
        candleAsOf: null as string | null,
        delayedMinutes: null as number | null,
        feed: null as string | null,
      };
    }

    const candleAsOf = new Date(chartLastTs * 1000).toISOString();
    const delayedMinutes = Math.max(0, Math.round(Math.max(0, clockTs / 1000 - chartLastTs) / 60));
    return {
      candleAsOf,
      delayedMinutes,
      feed: delayedMinutes > 0 ? "delayed" : "live",
    };
  }, [chartLastTs, clockTs]);

  const postChartStatus = useCallback(() => {
    if (!embedConfig.embed || typeof window === "undefined") return;
    const payload = {
      type: "WHOMP_CHART_STATUS",
      symbol: selected,
      candle_as_of: chartStatus.candleAsOf,
      delayed_minutes: chartStatus.delayedMinutes,
      feed: chartStatus.feed,
      seed: embedConfig.seed,
    };
    try {
      window.parent.postMessage(payload, "*");
    } catch {
      // Ignore postMessage failures.
    }
  }, [chartStatus.candleAsOf, chartStatus.delayedMinutes, chartStatus.feed, embedConfig.embed, embedConfig.seed, selected]);

  useEffect(() => {
    if (!embedConfig.embed) return;
    postChartStatus();
  }, [embedConfig.embed, postChartStatus]);

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

  const buildExtFiltered = useCallback(
    (rthCandles: Candle[], extCandlesInput: Candle[]) => {
      if (!extEnabled) return [];
      if (!extCandlesInput.length) return [];
      const rthTimes = new Set<number>();
      rthCandles.forEach((c) => rthTimes.add(Number(c.time)));
      return extCandlesInput.filter((c) => !rthTimes.has(Number(c.time)));
    },
    [extEnabled]
  );

  const applySnapshotToChart = useCallback(
    (snapshot: {
      candles: Candle[];
      extCandles: Candle[];
      volume: VolumePoint[];
      indicators: {
        sma20: LinePoint[];
        sma50: LinePoint[];
        sma200: LinePoint[];
        ema12: LinePoint[];
        ema26: LinePoint[];
        rsi14: LinePoint[];
        vwap: LinePoint[];
      };
    }) => {
      const mainSeries = seriesRef.current;
      if (!mainSeries) return;

      const extFiltered = buildExtFiltered(snapshot.candles, snapshot.extCandles);
      volumeDataRef.current = snapshot.volume;
      indicatorDataRef.current = snapshot.indicators;
      rthTimesRef.current = new Set(snapshot.candles.map((c) => Number(c.time)));

      if (snapshot.candles.length === 0 && extFiltered.length === 0) {
        mainSeries.setData([]);
        extSeriesRef.current?.setData([]);
        volumeRef.current?.setData([]);
        sma20Ref.current?.setData([]);
        sma50Ref.current?.setData([]);
        sma200Ref.current?.setData([]);
        ema12Ref.current?.setData([]);
        ema26Ref.current?.setData([]);
        vwapRef.current?.setData([]);
        rsiSeriesRef.current?.setData([]);
        lastCandleRef.current = null;
        setOhlc(null);
        setChartLastBarTs(0);
        return;
      }

      mainSeries.setData(snapshot.candles);
      if (extSeriesRef.current) {
        extSeriesRef.current.setData(extFiltered);
      }
      if (volumeRef.current) {
        volumeRef.current.setData(showVolume ? snapshot.volume : []);
      }
      if (sma20Ref.current) {
        sma20Ref.current.setData(showSma20 ? snapshot.indicators.sma20 : []);
      }
      if (sma50Ref.current) {
        sma50Ref.current.setData(showSma50 ? snapshot.indicators.sma50 : []);
      }
      if (sma200Ref.current) {
        sma200Ref.current.setData(showSma200 ? snapshot.indicators.sma200 : []);
      }
      if (ema12Ref.current) {
        ema12Ref.current.setData(showEma12 ? snapshot.indicators.ema12 : []);
      }
      if (ema26Ref.current) {
        ema26Ref.current.setData(showEma26 ? snapshot.indicators.ema26 : []);
      }
      if (vwapRef.current) {
        vwapRef.current.setData(showVwap ? snapshot.indicators.vwap : []);
      }
      if (rsiSeriesRef.current) {
        rsiSeriesRef.current.setData(showRsi ? snapshot.indicators.rsi14 : []);
      }

      const lastRth = snapshot.candles.length
        ? snapshot.candles[snapshot.candles.length - 1]
        : null;
      const lastExt = extFiltered.length ? extFiltered[extFiltered.length - 1] : null;
      let last = lastRth || lastExt;
      if (lastRth && lastExt && lastExt.time > lastRth.time) {
        last = lastExt;
      }
      if (last) {
        lastCandleRef.current = last;
        setOhlc(last);
        setChartLastBarTs(Number(last.time));
      }

      const timeScale = chartApiRef.current?.timeScale();
      if (timeScale && defaultViewRef.current) {
        const timeSet = new Set<number>();
        snapshot.candles.forEach((c) => timeSet.add(Number(c.time)));
        if (extFiltered.length) {
          extFiltered.forEach((c) => timeSet.add(Number(c.time)));
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
    },
    [
      buildExtFiltered,
      showEma12,
      showEma26,
      showRsi,
      showSma20,
      showSma200,
      showSma50,
      showVolume,
      showVwap,
      timeframe,
    ]
  );

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = `${selected}|${timeframe}|${extEnabled ? "1" : "0"}`;
    const requestSeq = fullFetchSeqRef.current + 1;
    fullFetchSeqRef.current = requestSeq;

    const run = async () => {
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
          { signal: controller.signal }
        );
        if (!res.ok) {
          throw new Error(`No data for ${selected}`);
        }
        const json = (await res.json()) as DataSnapshotResponse;
        if (controller.signal.aborted || requestSeq !== fullFetchSeqRef.current) {
          return;
        }
        const nextCandlesRaw = sanitizeCandles(
          (json.candles || [])
            .map((item: CandleWire) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: Candle, b: Candle) => a.time - b.time)
        );
        const nextExtRaw = sanitizeCandles(
          (json.ext_candles || [])
            .map((item: CandleWire) => ({
              ...item,
              time: toUtcTimestamp(Number(item.time)),
            }))
            .slice()
            .sort((a: Candle, b: Candle) => a.time - b.time)
        );
        const nextCandles = filterUnconfirmedSpikeCandles(nextCandlesRaw);
        const nextExt = filterUnconfirmedSpikeCandles(nextExtRaw);
        const maxBars = MAX_BARS_BY_TF[timeframe] ?? 600;
        function capArray<T>(arr: T[]): T[] {
          return arr.length > maxBars ? arr.slice(arr.length - maxBars) : arr;
        }
        const nextCandlesCapped = capArray(nextCandles);
        const nextExtCapped = capArray(nextExt);
        const nextVolume = (json.volume || [])
          .map((item: VolumePointWire) => ({
            ...item,
            time: toUtcTimestamp(Number(item.time)),
          }))
          .slice()
          .sort((a: VolumePoint, b: VolumePoint) => a.time - b.time);
        const nextIndicators = {
          sma20: capArray(
            (json.indicators?.sma20 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          sma50: capArray(
            (json.indicators?.sma50 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          sma200: capArray(
            (json.indicators?.sma200 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          ema12: capArray(
            (json.indicators?.ema12 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          ema26: capArray(
            (json.indicators?.ema26 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          rsi14: capArray(
            (json.indicators?.rsi14 || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
          vwap: capArray(
            (json.indicators?.vwap || [])
              .map((item: LinePointWire) => ({
                ...item,
                time: toUtcTimestamp(Number(item.time)),
              }))
              .slice()
              .sort((a: LinePoint, b: LinePoint) => a.time - b.time)
          ),
        };
        const nextVolumeCapped = capArray(nextVolume);
        setCandles(nextCandlesCapped);
        candlesRef.current = nextCandlesCapped;
        setExtCandles(nextExtCapped);
        extCandlesRef.current = nextExtCapped;
        setIndicatorData({
          sma20: nextIndicators.sma20,
          sma50: nextIndicators.sma50,
          sma200: nextIndicators.sma200,
          ema12: nextIndicators.ema12,
          ema26: nextIndicators.ema26,
          rsi14: nextIndicators.rsi14,
          vwap: nextIndicators.vwap,
        });
        setIndicatorLast({
          sma20: nextIndicators.sma20.length
            ? nextIndicators.sma20[nextIndicators.sma20.length - 1].value
            : undefined,
          sma50: nextIndicators.sma50.length
            ? nextIndicators.sma50[nextIndicators.sma50.length - 1].value
            : undefined,
          sma200: nextIndicators.sma200.length
            ? nextIndicators.sma200[nextIndicators.sma200.length - 1].value
            : undefined,
          ema12: nextIndicators.ema12.length
            ? nextIndicators.ema12[nextIndicators.ema12.length - 1].value
            : undefined,
          ema26: nextIndicators.ema26.length
            ? nextIndicators.ema26[nextIndicators.ema26.length - 1].value
            : undefined,
          vwap: nextIndicators.vwap.length
            ? nextIndicators.vwap[nextIndicators.vwap.length - 1].value
            : undefined,
          rsi14: nextIndicators.rsi14.length
            ? nextIndicators.rsi14[nextIndicators.rsi14.length - 1].value
            : undefined,
        });
        applySnapshotToChart({
          candles: nextCandlesCapped,
          extCandles: nextExtCapped,
          volume: nextVolumeCapped,
          indicators: {
            sma20: nextIndicators.sma20,
            sma50: nextIndicators.sma50,
            sma200: nextIndicators.sma200,
            ema12: nextIndicators.ema12,
            ema26: nextIndicators.ema26,
            rsi14: nextIndicators.rsi14,
            vwap: nextIndicators.vwap,
          },
        });
        lastLoadedDataKeyRef.current = requestKey;
        if (nextCandlesCapped.length === 0 && nextExtCapped.length === 0) {
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
          setIndicatorLast({});
          applySnapshotToChart({
            candles: [],
            extCandles: [],
            volume: [],
            indicators: {
              sma20: [],
              sma50: [],
              sma200: [],
              ema12: [],
              ema26: [],
              rsi14: [],
              vwap: [],
            },
          });
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
  }, [apiBase, applySnapshotToChart, selected, timeframe, extEnabled]);

  useEffect(() => {
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
  }, [apiBase, selected, watchlist, watchlistKey, timeframe, extEnabled]);

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

      const maxBars = MAX_BARS_BY_TF[timeframe] ?? 600;

      const upsertTail = <T extends { time: UTCTimestamp }>(arr: T[], incoming: T[]) => {
        const tailScan = 6;
        for (const item of incoming) {
          const t = Number(item.time);
          const last = arr.length ? Number(arr[arr.length - 1].time) : null;
          if (last == null) {
            arr.push(item);
            continue;
          }
          if (t === last) {
            arr[arr.length - 1] = item;
            continue;
          }
          if (t > last) {
            arr.push(item);
            continue;
          }
          // Rare: out-of-order update; search recent tail for exact match.
          for (let i = arr.length - 1; i >= 0 && arr.length - 1 - i < tailScan; i -= 1) {
            if (Number(arr[i].time) === t) {
              arr[i] = item;
              break;
            }
          }
        }
        if (arr.length > maxBars) {
          arr.splice(0, arr.length - maxBars);
        }
      };

      const mainSeries = seriesRef.current;
      const extSeries = extSeriesRef.current;
      const volSeries = volumeRef.current;

      if (incomingCandles.length) {
        upsertTail(candlesRef.current, incomingCandles);
        for (const bar of incomingCandles) {
          rthTimesRef.current.add(Number(bar.time));
          mainSeries?.update(bar);
          lastCandleRef.current = bar;
        }
      }

      const filteredExtIncoming = incomingExt.filter(
        (bar) => !rthTimesRef.current.has(Number(bar.time))
      );
      if (filteredExtIncoming.length) {
        upsertTail(extCandlesRef.current, filteredExtIncoming);
        if (extEnabledRef.current && extSeries) {
          for (const bar of filteredExtIncoming) {
            extSeries.update(bar);
            lastCandleRef.current = bar;
          }
        }
      }

      if (incomingVolume.length) {
        upsertTail(volumeDataRef.current, incomingVolume);
        if (togglesRef.current.showVolume && volSeries) {
          for (const bar of incomingVolume) {
            volSeries.update(bar);
          }
        }
      }

      const nextLast: {
        sma20?: number;
        sma50?: number;
        sma200?: number;
        ema12?: number;
        ema26?: number;
        vwap?: number;
        rsi14?: number;
      } = {};

      const updateIndicator = (
        key: keyof typeof indicatorDataRef.current,
        incoming: LinePoint[],
        enabled: boolean,
        series: ISeriesApi<"Line"> | null | undefined
      ) => {
        if (!incoming.length) return;
        upsertTail(indicatorDataRef.current[key], incoming);
        const last = incoming[incoming.length - 1];
        if (enabled && series) {
          series.update(last);
        }
        if (key === "sma20") nextLast.sma20 = last.value;
        if (key === "sma50") nextLast.sma50 = last.value;
        if (key === "sma200") nextLast.sma200 = last.value;
        if (key === "ema12") nextLast.ema12 = last.value;
        if (key === "ema26") nextLast.ema26 = last.value;
        if (key === "vwap") nextLast.vwap = last.value;
        if (key === "rsi14") nextLast.rsi14 = last.value;
      };

      updateIndicator(
        "sma20",
        incomingIndicators.sma20,
        togglesRef.current.showSma20,
        sma20Ref.current
      );
      updateIndicator(
        "sma50",
        incomingIndicators.sma50,
        togglesRef.current.showSma50,
        sma50Ref.current
      );
      updateIndicator(
        "sma200",
        incomingIndicators.sma200,
        togglesRef.current.showSma200,
        sma200Ref.current
      );
      updateIndicator(
        "ema12",
        incomingIndicators.ema12,
        togglesRef.current.showEma12,
        ema12Ref.current
      );
      updateIndicator(
        "ema26",
        incomingIndicators.ema26,
        togglesRef.current.showEma26,
        ema26Ref.current
      );
      updateIndicator(
        "vwap",
        incomingIndicators.vwap,
        togglesRef.current.showVwap,
        vwapRef.current
      );
      updateIndicator(
        "rsi14",
        incomingIndicators.rsi14,
        togglesRef.current.showRsi,
        rsiSeriesRef.current
      );

      if (Object.keys(nextLast).length) {
        setIndicatorLast((prev) => ({ ...prev, ...nextLast }));
      }

      const lastRth = candlesRef.current.length
        ? candlesRef.current[candlesRef.current.length - 1]
        : null;
      let lastExt: Candle | null = null;
      for (let i = extCandlesRef.current.length - 1; i >= 0; i -= 1) {
        const bar = extCandlesRef.current[i];
        if (!rthTimesRef.current.has(Number(bar.time))) {
          lastExt = bar;
          break;
        }
      }
      const last = (() => {
        if (lastRth && lastExt) {
          return lastExt.time > lastRth.time ? lastExt : lastRth;
        }
        return lastRth || lastExt;
      })();
      if (last) {
        setChartLastBarTs(Number(last.time));
        setOhlc(last);
      }
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

  if (embedConfig.canvasOnly) {
    return (
      <div className="chart-embed-shell">
        <div className="chart-stage chart-stage--embed">
          <div
            className="chart-container chart-container--embed"
            ref={chartRef}
            aria-label="Embedded chart canvas"
          />
        </div>
      </div>
    );
  }

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
                {headerExchange && <span className="tv-exchange">{headerExchange}</span>}
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

      <div className="main-container">
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

        <aside className="watchlist-section">
          <div className="watchlist-header">
            <span>Watchlist</span>
            <div className="watchlist-meta">
              <span
                className={`watchlist-state ${quotesStale ? "is-stale" : "is-live"}`}
                title={
                  quotesStale
                    ? "Using cached quotes due to upstream delay/error."
                    : "Receiving delayed stream updates."
                }
              >
                {quotesStale ? "Stale" : "Live"}
              </span>
              <span
                className="watchlist-updated"
                title={
                  watchlistLastQuoteTs
                    ? `Latest quote ${new Date(
                        watchlistLastQuoteTs * 1000
                      ).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true,
                      })}`
                    : "No quote timestamp yet."
                }
              >
                {watchlistFreshnessLabel}
              </span>
              <span className="watchlist-count">{watchlist.length} Active</span>
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
                <div
                  key={`${item.symbol}-${item.exchange}`}
                  className="search-item"
                  onClick={() => addSymbol(item.symbol)}
                >
                  <div className="search-main">
                    <div className="search-symbol">{item.symbol}</div>
                    <div className="search-name">{item.name}</div>
                  </div>
                  <div className="search-meta">
                    {[item.exchange, item.type].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="watchlist-items">
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
                        {quote?.exchange || "—"}
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
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
          <div className="watchlist-detail">
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
              {quotes[selected]?.exchange || "—"}
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
          <div className="watchlist-news">
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
                    {item.time ? ` · ${new Date(item.time).toLocaleString()}` : ""}
                  </div>
                </a>
              ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
