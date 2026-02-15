from __future__ import annotations

from datetime import datetime
from email.utils import parsedate_to_datetime
import json
import os
from threading import Event, Lock, Thread
from typing import Dict, List, Optional
import time
from urllib import request as urllib_request
import xml.etree.ElementTree as ET

import pandas as pd
import requests
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="FadingView API")


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


_DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]
_ALLOWED_ORIGINS = [
    item.strip()
    for item in os.getenv("ALLOWED_ORIGINS", ",".join(_DEFAULT_ALLOWED_ORIGINS)).split(",")
    if item.strip()
]
_AUTH_ENABLED = _env_bool("FV_AUTH_ENABLED", False)
_AUTH_TOKEN = os.getenv("FV_API_TOKEN", "").strip()
_PUBLIC_API_PATHS = (
    "/api/health",
    "/api/data",
    "/api/data_delta",
    "/api/stream/data",
    "/api/chart/data",
    "/api/chart/data_delta",
    "/api/chart/stream/data",
    "/api/symbols",
    "/api/quotes",
    "/api/stream/quotes",
    "/api/prewarm",
    "/api/news",
)
_RATE_LIMIT_ENABLED = _env_bool("FV_RATE_LIMIT_ENABLED", True)
_RATE_LIMIT_RPM = max(0, int(os.getenv("FV_RATE_LIMIT_RPM", "120")))
_FRESH_DATA_RATE_MULTIPLIER = max(1, int(os.getenv("FV_FRESH_DATA_RATE_MULTIPLIER", "6")))

_CHART_RATE_LIMIT_ENABLED = _env_bool("FV_CHART_RATE_LIMIT_ENABLED", _RATE_LIMIT_ENABLED)
_CHART_RATE_LIMIT_RPM = max(0, int(os.getenv("FV_CHART_RATE_LIMIT_RPM", "2400")))
_CHART_FRESH_DATA_RATE_MULTIPLIER = max(
    1,
    int(os.getenv("FV_CHART_FRESH_DATA_RATE_MULTIPLIER", "24")),
)

_CHART_RATE_LIMIT_PATHS = (
    "/api/data",
    "/api/data_delta",
    "/api/stream/data",
    "/api/chart/data",
    "/api/chart/data_delta",
    "/api/chart/stream/data",
)
_RATE_LIMIT_LOCK = Lock()
_RATE_LIMIT_STATE: Dict[str, Dict[str, int]] = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_DATA_CACHE: Dict[str, Dict[str, object]] = {}
_SEARCH_CACHE: Dict[str, Dict[str, object]] = {}
_META_CACHE: Dict[str, Dict[str, object]] = {}
_DATA_TTL_DEFAULT = 60
_DATA_TTL_BY_TF = {
    "1m": 20,
    "5m": 30,
    "15m": 60,
    "30m": 90,
    "1h": 120,
    "4h": 300,
    "1d": 900,
    "1w": 3600,
}
_SEARCH_TTL = 300
_QUOTE_TTL = 15
_META_TTL = 3600
_HOT_DATA_TTL = 600
_HOT_QUOTES_TTL = 600
_REFRESH_TICK = 5
_REFRESH_LOCK = Lock()
_STOP_EVENT = Event()
_DATA_REFRESH_INFLIGHT: set[str] = set()
_QUOTE_REFRESH_INFLIGHT: set[str] = set()
_DATA_BUILD_LOCK = Lock()
_DATA_BUILD_INFLIGHT: Dict[str, Event] = {}
_HOT_DATA: Dict[str, Dict[str, object]] = {}
_HOT_QUOTES_RTH: Dict[str, float] = {}
_HOT_QUOTES_EXT: Dict[str, float] = {}

_INTERVALS = {
    "1m": ("1d", "1m"),
    "5m": ("5d", "5m"),
    "15m": ("5d", "15m"),
    "30m": ("60d", "30m"),
    "1h": ("1mo", "1h"),
    "4h": ("60d", "1h"),
    "1d": ("1y", "1d"),
    "1w": ("5y", "1wk"),
}
_FALLBACK_PERIODS = {
    "1m": "7d",
    "5m": "30d",
    "15m": "60d",
    "30m": "1y",
    "1h": "6mo",
    "4h": "1y",
}
_MIN_BARS = {
    "1m": 200,
    "5m": 200,
    "15m": 200,
    "30m": 160,
    "1h": 120,
    "4h": 80,
}
_DATA_STREAM_TICK_BY_TF = {
    "1m": 3,
    "5m": 5,
    "15m": 8,
    "30m": 12,
    "1h": 15,
    "4h": 30,
    "1d": 30,
    "1w": 45,
}

_YF_TIMEOUT_SECONDS = 8
_YF_RETRIES = 3

_OHLC_FIELDS = {"Open", "High", "Low", "Close", "Adj Close", "Volume"}


def _extract_auth_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    query_token = request.query_params.get("token", "").strip()
    if query_token:
        return query_token
    cookie_token = (request.cookies.get("fv_auth_token") or "").strip()
    if cookie_token:
        return cookie_token
    return request.headers.get("x-api-key", "").strip()


def _is_public_api_path(path: str) -> bool:
    normalized = path.rstrip("/")
    return any(
        normalized == public or normalized.startswith(f"{public}/")
        for public in _PUBLIC_API_PATHS
    )


def _is_chart_api_path(path: str) -> bool:
    normalized = path.rstrip("/")
    return any(
        normalized == chart_path or normalized.startswith(f"{chart_path}/")
        for chart_path in _CHART_RATE_LIMIT_PATHS
    )


def _rate_limit_for_path(path: str, method: str, query=None) -> tuple[bool, int]:
    if _is_chart_api_path(path):
        enabled = _CHART_RATE_LIMIT_ENABLED
        rpm = _CHART_RATE_LIMIT_RPM
        fresh_multiplier = _CHART_FRESH_DATA_RATE_MULTIPLIER
    else:
        enabled = _RATE_LIMIT_ENABLED
        rpm = _RATE_LIMIT_RPM
        fresh_multiplier = _FRESH_DATA_RATE_MULTIPLIER

    if not enabled or rpm <= 0:
        return False, -1

    effective_limit = rpm
    if path is not None and query is not None:
        if _is_fresh_cached_data_request(path, query, method):
            effective_limit = rpm * fresh_multiplier
    return True, effective_limit


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "").strip()
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _check_rate_limit(
    ip: str, *, path: str | None = None, method: str = "GET", query=None
) -> tuple[bool, int, int]:
    if not path:
        return True, -1, -1

    _, effective_limit = _rate_limit_for_path(path, method, query)
    if effective_limit <= 0:
        return True, -1, effective_limit

    window = int(time.time() // 60)
    is_chart = _is_chart_api_path(path)
    rate_key = f"{ip}:fresh" if is_chart or effective_limit != _RATE_LIMIT_RPM else ip
    with _RATE_LIMIT_LOCK:
        entry = _RATE_LIMIT_STATE.get(rate_key)
        if not entry or entry.get("window", -1) != window:
            entry = {"window": window, "count": 0}
            _RATE_LIMIT_STATE[rate_key] = entry
        count = int(entry.get("count", 0))
        if count >= effective_limit:
            return False, 0, effective_limit
        count += 1
        entry["count"] = count
        remaining = max(0, effective_limit - count)
        if len(_RATE_LIMIT_STATE) > 8000:
            stale_windows = {window - 2, window - 1}
            for key in list(_RATE_LIMIT_STATE.keys()):
                if _RATE_LIMIT_STATE[key].get("window") not in stale_windows:
                    _RATE_LIMIT_STATE.pop(key, None)
        return True, remaining, effective_limit


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api"):
        # Always allow CORS preflight to pass quickly.
        if request.method.upper() == "OPTIONS":
            return await call_next(request)

        if not _is_public_api_path(path):
            if _AUTH_ENABLED:
                if not _AUTH_TOKEN:
                    return JSONResponse(
                        status_code=503,
                        content={"detail": "Auth enabled but FV_API_TOKEN is not configured"},
                    )
                token = _extract_auth_token(request)
                if token != _AUTH_TOKEN:
                    return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        ip = _client_ip(request)
        allowed, remaining, effective_limit = _check_rate_limit(
            ip,
            path=request.url.path,
            method=request.method,
            query=request.query_params,
        )
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded"},
                headers={"Retry-After": "60"},
            )
        response = await call_next(request)
        if effective_limit > 0:
            response.headers["X-RateLimit-Limit"] = str(effective_limit)
            if remaining >= 0:
                response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response
    return await call_next(request)


def _is_fresh_cached_data_request(path: str, query: Dict[str, str], method: str) -> bool:
    if method != "GET":
        return False
    normalized_path = path.rstrip("/")
    if normalized_path.startswith("/api/data/"):
        raw_symbol = normalized_path[len("/api/data/") :].strip()
    elif normalized_path.startswith("/api/data_delta/"):
        raw_symbol = normalized_path[len("/api/data_delta/") :].strip()
    elif normalized_path.startswith("/api/chart/data/"):
        raw_symbol = normalized_path[len("/api/chart/data/") :].strip()
    elif normalized_path.startswith("/api/chart/data_delta/"):
        raw_symbol = normalized_path[len("/api/chart/data_delta/") :].strip()
    else:
        return False
    if not raw_symbol:
        return False

    symbol = _normalize_symbol(raw_symbol)
    if not symbol:
        return False

    tf = (query.get("tf", "5m") or "5m").lower()
    ext = (query.get("ext", "0") or "0").strip().lower() in {"1", "true", "yes", "on"}
    cache_key = f"{symbol}:{tf}:{1 if ext else 0}"
    ttl = _get_data_ttl(tf)
    entry = _cache_peek(_DATA_CACHE, cache_key)
    return entry is not None and not _cache_is_stale(entry, ttl)


def _cache_get(cache: Dict[str, Dict[str, object]], key: str, ttl: int):
    entry = cache.get(key)
    if not entry:
        return None
    if time.time() - entry["ts"] > ttl:
        cache.pop(key, None)
        return None
    return entry["value"]


def _cache_peek(cache: Dict[str, Dict[str, object]], key: str):
    return cache.get(key)


def _cache_is_stale(entry: Dict[str, object], ttl: int) -> bool:
    return time.time() - entry["ts"] > ttl


def _cache_set(cache: Dict[str, Dict[str, object]], key: str, value: object):
    cache[key] = {"ts": time.time(), "value": value}


def _yf_download_with_retry(
    tickers,
    *,
    period: str,
    interval: str,
    prepost: bool,
    retries: int = _YF_RETRIES,
    timeout: int = _YF_TIMEOUT_SECONDS,
) -> pd.DataFrame:
    last_error: Optional[Exception] = None
    for attempt in range(max(1, retries)):
        try:
            df = yf.download(
                tickers,
                period=period,
                interval=interval,
                progress=False,
                prepost=prepost,
                auto_adjust=False,
                timeout=timeout,
                threads=False,
            )
            if isinstance(df, pd.DataFrame) and not df.empty:
                return df
        except Exception as exc:
            last_error = exc
        if attempt < retries - 1:
            time.sleep(0.35 * (attempt + 1))
    if last_error:
        raise last_error
    return pd.DataFrame()


def _requests_json_with_retry(url: str, *, params: Dict[str, object], retries: int = 2, timeout: int = 8):
    last_error: Optional[Exception] = None
    for attempt in range(max(1, retries)):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            last_error = exc
        if attempt < retries - 1:
            time.sleep(0.25 * (attempt + 1))
    if last_error:
        raise last_error
    return {}


def _normalize_symbol(symbol: str) -> str:
    return "".join(ch for ch in symbol.upper().strip() if ch.isalnum() or ch in "=.-^/")


def _extract_symbol_df(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    if not isinstance(df.columns, pd.MultiIndex):
        return df
    level0 = df.columns.get_level_values(0)
    level1 = df.columns.get_level_values(1)
    level0_set = set(level0)
    level1_set = set(level1)
    if level1_set.issubset(_OHLC_FIELDS):
        if symbol in level0:
            return df[symbol]
        return pd.DataFrame()
    if level0_set.issubset(_OHLC_FIELDS):
        if symbol in level1:
            return df.xs(symbol, level=1, axis=1)
        return pd.DataFrame()
    if symbol in level0:
        return df[symbol]
    if symbol in level1:
        return df.xs(symbol, level=1, axis=1)
    return pd.DataFrame()


def _resample_ohlc(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    if df.empty:
        return df
    resampled = (
        df.resample(rule)
        .agg(
            {
                "Open": "first",
                "High": "max",
                "Low": "min",
                "Close": "last",
                "Volume": "sum",
            }
        )
        .dropna(subset=["Open", "High", "Low", "Close"])
    )
    return resampled

def _df_to_candles(df: pd.DataFrame) -> List[Dict[str, object]]:
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.droplevel(1)
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    candles = []
    for ts, row in df.iterrows():
        timestamp = int(pd.Timestamp(ts).timestamp())
        candles.append(
            {
                "time": timestamp,
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]) if "Volume" in row else 0.0,
            }
        )
    return candles


def _df_to_volume(df: pd.DataFrame) -> List[Dict[str, object]]:
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.droplevel(1)
    df = df.dropna(subset=["Open", "Close", "Volume"])
    volume = []
    for ts, row in df.iterrows():
        timestamp = int(pd.Timestamp(ts).timestamp())
        try:
            vol = float(row["Volume"])
        except Exception:
            vol = 0.0
        up = float(row["Close"]) >= float(row["Open"])
        volume.append(
            {
                "time": timestamp,
                "value": vol,
                "color": "#00d084" if up else "#ff5a5f",
            }
        )
    return volume


def _df_to_line(df: pd.DataFrame, column: str) -> List[Dict[str, object]]:
    if column not in df.columns:
        return []
    series = df[column].dropna()
    out = []
    for ts, val in series.items():
        out.append({"time": int(pd.Timestamp(ts).timestamp()), "value": float(val)})
    return out


def _compute_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = gains.rolling(period).mean()
    avg_loss = losses.rolling(period).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _compute_vwap(df: pd.DataFrame) -> pd.Series:
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    volume = df["Volume"].replace(0, pd.NA)
    cum_vol = volume.cumsum()
    cum_tp = (typical * volume).cumsum()
    vwap = cum_tp / cum_vol
    return vwap


def _split_sessions(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if df.empty:
        return df, df
    idx = df.index
    try:
        if idx.tz is None:
            idx = idx.tz_localize("UTC")
        idx = idx.tz_convert("US/Eastern")
    except Exception:
        return df, df.iloc[0:0]
    hours = idx.hour
    minutes = idx.minute
    mask_rth = (
        (hours > 9) | ((hours == 9) & (minutes >= 30))
    ) & ((hours < 16) | ((hours == 16) & (minutes == 0)))
    rth_df = df[mask_rth]
    ext_df = df[~mask_rth]
    return rth_df, ext_df


def _filter_ext_outliers(
    ext_df: pd.DataFrame, reference_df: pd.DataFrame
) -> pd.DataFrame:
    if ext_df.empty or reference_df.empty:
        return ext_df
    ranges = (reference_df["High"] - reference_df["Low"]).dropna()
    if ranges.empty:
        return ext_df
    recent = ranges.tail(200)
    median = recent.median()
    q1 = recent.quantile(0.25)
    q3 = recent.quantile(0.75)
    iqr = q3 - q1
    if iqr and iqr > 0:
        base_threshold = median + 4 * iqr
    else:
        base_threshold = median * 4
    last_close = reference_df["Close"].iloc[-1]
    pct_threshold = last_close * 0.015  # 1.5% move per bar cap for EXT noise
    threshold = max(base_threshold, pct_threshold)
    ext_ranges = ext_df["High"] - ext_df["Low"]
    ref_vol = reference_df["Volume"].dropna()
    vol_median = ref_vol.tail(200).median() if not ref_vol.empty else None
    if vol_median and vol_median > 0:
        low_vol = ext_df["Volume"].fillna(0) <= vol_median * 0.1
        keep = (ext_ranges <= threshold) | (~low_vol)
        return ext_df[keep]
    return ext_df[ext_ranges <= threshold]


def _filter_intraday_outliers(
    df: pd.DataFrame, tf: str, is_24_7: bool
) -> pd.DataFrame:
    # Yahoo occasionally emits one-off bad intraday bars (wrong scale/price).
    # Drop only extreme, unconfirmed outliers to avoid chart "cliff" candles.
    if df.empty or is_24_7 or tf in ("1d", "1w"):
        return df
    try:
        close = df["Close"].astype(float)
        high = df["High"].astype(float)
        low = df["Low"].astype(float)

        rolling_med = close.rolling(48, min_periods=12).median().shift(1)
        baseline = rolling_med.fillna(close.expanding(min_periods=1).median())
        baseline = baseline.replace(0, pd.NA)

        dev_pct = (close - baseline).abs() / baseline
        range_pct = (high - low).abs() / baseline
        extreme = (dev_pct > 0.35) & (range_pct > 0.03)

        next_close = close.shift(-1)
        next_dev = (next_close - close).abs() / close.replace(0, pd.NA)
        confirmed_move = next_dev <= 0.12

        drop_mask = extreme & (~confirmed_move.fillna(False))
        drop_mask = drop_mask | (extreme & next_close.isna())
        if drop_mask.any():
            return df.loc[~drop_mask]
    except Exception:
        return df
    return df


def _get_quote_snapshot(symbols: List[str], include_prepost: bool = False) -> Dict[str, Dict[str, object]]:
    if not symbols:
        return {}
    tickers = list(dict.fromkeys(symbols))
    try:
        df = _yf_download_with_retry(
            tickers,
            period="1d",
            interval="1m",
            prepost=include_prepost,
            retries=2,
            timeout=6,
        )
    except Exception:
        return {}
    if df.empty:
        return {}
    quotes: Dict[str, Dict[str, float]] = {}
    for sym in tickers:
        try:
            if isinstance(df.columns, pd.MultiIndex):
                sym_df = _extract_symbol_df(df, sym)
                series = sym_df["Close"].dropna()
            else:
                series = df["Close"].dropna()
            spark = series.tail(30).tolist()
            if len(series) >= 2:
                last = float(series.iloc[-1])
                prev = float(series.iloc[-2])
            elif len(series) == 1:
                last = float(series.iloc[-1])
                prev = None
            else:
                continue
            session = "rth"
            last_ts_epoch = None
            rth_last = None
            ext_last = None
            ext_change = None
            ext_change_pct = None
            rth_change = None
            rth_change_pct = None
            if not series.empty:
                try:
                    ts = pd.Timestamp(series.index[-1])
                    if ts.tz is None:
                        ts = ts.tz_localize("UTC")
                    last_ts_epoch = int(ts.timestamp())
                except Exception:
                    last_ts_epoch = None
            meta = _get_symbol_meta(sym)
            prev_close = meta.get("prev_close")
            if include_prepost and not series.empty:
                try:
                    idx = series.index
                    if idx.tz is None:
                        idx = idx.tz_localize("UTC")
                    idx = idx.tz_convert("US/Eastern")
                    hours = idx.hour
                    minutes = idx.minute
                    mask_rth = (
                        (hours > 9) | ((hours == 9) & (minutes >= 30))
                    ) & ((hours < 16) | ((hours == 16) & (minutes == 0)))
                    rth_series = series[mask_rth]
                    if not rth_series.empty:
                        rth_last = float(rth_series.iloc[-1])
                    # Session should follow the latest candle, not the latest
                    # extended-hours candle from earlier in the day.
                    last_ts = pd.Timestamp(idx[-1])
                    hh = int(last_ts.hour)
                    mm = int(last_ts.minute)
                    last_is_rth = bool(mask_rth[-1]) if len(mask_rth) else False
                    if last_is_rth:
                        session = "rth"
                        ext_last = None
                    else:
                        ext_last = float(series.iloc[-1])
                        before_open = (hh < 9) or (hh == 9 and mm < 30)
                        session = "pre" if before_open else "post"
                except Exception:
                    session = "rth"
            rth_price = rth_last if rth_last is not None else None
            if rth_price is None and prev_close is not None:
                rth_price = float(prev_close)
            if rth_price is None:
                rth_price = last
            display_price = ext_last if include_prepost and ext_last is not None else rth_price
            if ext_last is not None and rth_price is not None:
                ext_change = ext_last - rth_price
                ext_change_pct = (ext_change / rth_price * 100) if rth_price else 0.0
            if prev_close is not None:
                try:
                    prev_close_value = float(prev_close)
                except Exception:
                    prev_close_value = None
            else:
                prev_close_value = None
            if prev_close_value:
                change = display_price - prev_close_value
                pct = (change / prev_close_value * 100) if prev_close_value else 0.0
                rth_change = rth_price - prev_close_value
                rth_change_pct = (rth_change / prev_close_value * 100) if prev_close_value else 0.0
            elif prev is not None:
                change = display_price - prev
                pct = (change / prev * 100) if prev else 0.0
                rth_change = rth_price - prev
                rth_change_pct = (rth_change / prev * 100) if prev else 0.0
            else:
                change = 0.0
                pct = 0.0
                rth_change = 0.0
                rth_change_pct = 0.0
            quotes[sym] = {
                "price": display_price,
                "change": change,
                "change_pct": pct,
                "spark": spark,
                "exchange": meta.get("exchange", ""),
                "name": meta.get("name", ""),
                "currency": meta.get("currency", ""),
                "session": session,
                "last_ts": last_ts_epoch,
                "rth_price": rth_price,
                "ext_price": ext_last,
                "ext_change": ext_change,
                "ext_change_pct": ext_change_pct,
                "rth_change": rth_change,
                "rth_change_pct": rth_change_pct,
            }
        except Exception:
            continue
    return quotes


def _get_data_ttl(tf: str) -> int:
    return _DATA_TTL_BY_TF.get(tf, _DATA_TTL_DEFAULT)


def _get_stream_tick(tf: str) -> int:
    return _DATA_STREAM_TICK_BY_TF.get(tf, 15)


def _get_cached_symbol_payload(symbol: str, tf: str, ext: bool) -> Dict[str, object]:
    ttl = _get_data_ttl(tf)
    cache_key = f"{symbol}:{tf}:{1 if ext else 0}"
    _mark_hot_data(symbol, tf, ext)
    while True:
        entry = _cache_peek(_DATA_CACHE, cache_key)
        if entry and not _cache_is_stale(entry, ttl):
            return entry["value"]

        stale_entry = entry if entry and _cache_is_stale(entry, ttl) else None

        wait_event: Optional[Event] = None
        should_build = False

        with _DATA_BUILD_LOCK:
            existing = _DATA_BUILD_INFLIGHT.get(cache_key)
            if existing is None:
                wait_event = Event()
                _DATA_BUILD_INFLIGHT[cache_key] = wait_event
                should_build = True
            else:
                wait_event = existing

        if should_build:
            try:
                payload = _build_symbol_payload(symbol, tf, ext)
                _cache_set(_DATA_CACHE, cache_key, payload)
                return payload
            except Exception:
                if stale_entry is not None and stale_entry.get("value") is not None:
                    return stale_entry["value"]
                raise
            finally:
                with _DATA_BUILD_LOCK:
                    _DATA_BUILD_INFLIGHT.pop(cache_key, None)
                if wait_event is not None:
                    wait_event.set()
        else:
            if wait_event is not None:
                wait_event.wait(timeout=12)
            # Re-check cache after the in-flight request has finished (or timed out).
            # If the builder failed and there is a stale snapshot, continue using it.
            entry = _cache_peek(_DATA_CACHE, cache_key)
            if entry and not _cache_is_stale(entry, ttl):
                return entry["value"]
            if entry is not None and stale_entry is not None and entry.get("value") is not None:
                # Keep serving stale data during temporary upstream flakiness.
                return entry["value"]
            if stale_entry is not None and stale_entry.get("value") is not None:
                return stale_entry["value"]


def _filter_series_since(
    items: List[Dict[str, object]], since_ts: int
) -> List[Dict[str, object]]:
    if since_ts <= 0:
        return items
    out: List[Dict[str, object]] = []
    for item in items:
        ts = int(item.get("time", 0))
        if ts >= since_ts:
            out.append(item)
    return out


def _build_delta_from_payload(
    payload: Dict[str, object], since_ts: int
) -> Dict[str, object]:
    candles = payload.get("candles", [])
    ext_candles = payload.get("ext_candles", [])
    volume = payload.get("volume", [])
    if not isinstance(candles, list):
        candles = []
    if not isinstance(ext_candles, list):
        ext_candles = []
    if not isinstance(volume, list):
        volume = []
    indicators = payload.get("indicators", {})
    delta_indicators: Dict[str, List[Dict[str, object]]] = {}
    if isinstance(indicators, dict):
        for key, values in indicators.items():
            if isinstance(values, list):
                delta_indicators[key] = _filter_series_since(values, since_ts)
            else:
                delta_indicators[key] = []

    latest_time = 0
    for rows in (candles, ext_candles, volume):
        if rows:
            latest_time = max(latest_time, int(rows[-1].get("time", 0)))
    return {
        "symbol": payload.get("symbol", ""),
        "timeframe": payload.get("timeframe", ""),
        "ext": payload.get("ext", False),
        "delta": True,
        "since": since_ts,
        "latest_time": latest_time,
        "candles": _filter_series_since(candles, since_ts),
        "ext_candles": _filter_series_since(ext_candles, since_ts),
        "volume": _filter_series_since(volume, since_ts),
        "indicators": delta_indicators,
    }


def _delta_signature(delta: Dict[str, object]) -> str:
    indicators = delta.get("indicators", {})
    if not isinstance(indicators, dict):
        indicators = {}
    compact = {
        "latest_time": int(delta.get("latest_time", 0)),
        "candles_last": (delta.get("candles", []) or [])[-1:] if isinstance(delta.get("candles"), list) else [],
        "ext_last": (delta.get("ext_candles", []) or [])[-1:] if isinstance(delta.get("ext_candles"), list) else [],
        "vol_last": (delta.get("volume", []) or [])[-1:] if isinstance(delta.get("volume"), list) else [],
        "ind_last": {
            key: (values[-1:] if isinstance(values, list) else [])
            for key, values in indicators.items()
        },
    }
    return json.dumps(compact, sort_keys=True)


def _mark_hot_data(symbol: str, tf: str, ext: bool):
    key = f"{symbol}:{tf}:{1 if ext else 0}"
    with _REFRESH_LOCK:
        _HOT_DATA[key] = {
            "symbol": symbol,
            "tf": tf,
            "ext": ext,
            "last_seen": time.time(),
        }


def _mark_hot_quotes(symbols: List[str], include_prepost: bool = False):
    now = time.time()
    target = _HOT_QUOTES_EXT if include_prepost else _HOT_QUOTES_RTH
    with _REFRESH_LOCK:
        for symbol in symbols:
            target[symbol] = now


def _build_symbol_payload(symbol: str, tf: str, ext: bool) -> Dict[str, object]:
    include_prepost = ext and tf not in ("1d", "1w")
    is_24_7 = _is_24_7(symbol)
    period, interval = _INTERVALS.get(tf, ("5d", "5m"))
    df = _yf_download_with_retry(
        symbol,
        period=period,
        interval=interval,
        prepost=include_prepost,
    )
    min_bars = _MIN_BARS.get(tf)
    fallback_period = _FALLBACK_PERIODS.get(tf)
    if min_bars and fallback_period and len(df) < min_bars and fallback_period != period:
        df = _yf_download_with_retry(
            symbol,
            period=fallback_period,
            interval=interval,
            prepost=include_prepost,
        )
    if df.empty:
        raise HTTPException(status_code=404, detail="No data")
    df = _extract_symbol_df(df, symbol)
    if df.empty:
        raise HTTPException(status_code=404, detail="No data")
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.droplevel(1)

    base_df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
    base_df = _filter_intraday_outliers(base_df, tf=tf, is_24_7=is_24_7)
    if tf == "4h":
        base_df = _resample_ohlc(base_df, "4H")
    close = base_df["Close"]
    ind_df = pd.DataFrame(index=base_df.index)
    ind_df["SMA20"] = close.rolling(20).mean()
    ind_df["SMA50"] = close.rolling(50).mean()
    ind_df["SMA200"] = close.rolling(200).mean()
    ind_df["EMA12"] = close.ewm(span=12, adjust=False).mean()
    ind_df["EMA26"] = close.ewm(span=26, adjust=False).mean()
    ind_df["RSI14"] = _compute_rsi(close, 14)
    ind_df["VWAP"] = _compute_vwap(base_df)

    split_sessions = include_prepost and not is_24_7 and tf not in ("4h",)
    if split_sessions:
        rth_df, ext_df = _split_sessions(base_df)
        if not rth_df.empty and not ext_df.empty:
            ext_df = ext_df[~ext_df.index.isin(rth_df.index)]
        if not rth_df.empty:
            rth_df = rth_df[~rth_df.index.duplicated(keep="last")]
        if not ext_df.empty:
            ext_df = ext_df[~ext_df.index.duplicated(keep="last")]
        ext_df = _filter_ext_outliers(ext_df, rth_df if not rth_df.empty else base_df)
        candles = _df_to_candles(rth_df)
        ext_candles = _df_to_candles(ext_df)
    else:
        candles = _df_to_candles(base_df)
        ext_candles = []

    return {
        "symbol": symbol,
        "timeframe": tf,
        "ext": include_prepost,
        "candles": candles,
        "ext_candles": ext_candles,
        "indicators": {
            "sma20": _df_to_line(ind_df, "SMA20"),
            "sma50": _df_to_line(ind_df, "SMA50"),
            "sma200": _df_to_line(ind_df, "SMA200"),
            "ema12": _df_to_line(ind_df, "EMA12"),
            "ema26": _df_to_line(ind_df, "EMA26"),
            "rsi14": _df_to_line(ind_df, "RSI14"),
            "vwap": _df_to_line(ind_df, "VWAP"),
        },
        "volume": _df_to_volume(base_df),
    }


def _get_chart_data_payload(symbol: str, tf: str, ext: bool) -> Dict[str, object]:
    symbol = _normalize_symbol(symbol)
    if not symbol:
        raise HTTPException(status_code=400, detail="Invalid symbol")
    tf = tf.lower()
    return _get_cached_symbol_payload(symbol, tf, ext)


def _get_chart_data_delta_payload(
    symbol: str, tf: str, ext: bool, since: int
) -> Dict[str, object]:
    payload = _get_chart_data_payload(symbol, tf, ext)
    since_ts = max(0, int(since))
    return _build_delta_from_payload(payload, since_ts)


def _stream_chart_data_response(
    symbol: str, tf: str, ext: bool, since: int
) -> StreamingResponse:
    symbol = _normalize_symbol(symbol)
    if not symbol:
        raise HTTPException(status_code=400, detail="Invalid symbol")
    tf = tf.lower()
    since_ts = max(0, int(since))
    _mark_hot_data(symbol, tf, ext)
    tick = _get_stream_tick(tf)

    def event_stream():
        nonlocal since_ts
        last_sig = ""
        stream_error = False
        while not _STOP_EVENT.is_set():
            try:
                payload = _get_cached_symbol_payload(symbol, tf, ext)
                delta = _build_delta_from_payload(payload, since_ts)
                has_updates = (
                    len(delta.get("candles", []))
                    or len(delta.get("ext_candles", []))
                    or len(delta.get("volume", []))
                    or any(len(v) for v in (delta.get("indicators", {}) or {}).values())
                )
                stream_error = False
                if has_updates:
                    sig = _delta_signature(delta)
                    if sig != last_sig:
                        last_sig = sig
                        latest_time = int(delta.get("latest_time", 0))
                        if latest_time > 0:
                            since_ts = max(since_ts, latest_time)
                        yield f"data: {json.dumps(delta)}\n\n"
            except Exception:
                if not stream_error:
                    error_payload = {
                        "type": "stream_error",
                        "message": "temporary data error",
                        "symbol": symbol,
                        "timeframe": tf,
                        "ext": ext,
                    }
                    yield f"data: {json.dumps(error_payload)}\n\n"
                    stream_error = True
            _STOP_EVENT.wait(tick)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _refresh_hot_data():
    now = time.time()
    with _REFRESH_LOCK:
        hot_items = list(_HOT_DATA.items())
    for key, meta in hot_items:
        if now - float(meta.get("last_seen", 0)) > _HOT_DATA_TTL:
            with _REFRESH_LOCK:
                _HOT_DATA.pop(key, None)
            continue
        ttl = _get_data_ttl(str(meta.get("tf", "")))
        entry = _cache_peek(_DATA_CACHE, key)
        if entry and not _cache_is_stale(entry, ttl):
            continue
        with _REFRESH_LOCK:
            if key in _DATA_REFRESH_INFLIGHT:
                continue
            _DATA_REFRESH_INFLIGHT.add(key)
        try:
            payload = _build_symbol_payload(
                str(meta.get("symbol", "")),
                str(meta.get("tf", "")),
                bool(meta.get("ext", False)),
            )
            _cache_set(_DATA_CACHE, key, payload)
        except Exception:
            pass
        finally:
            with _REFRESH_LOCK:
                _DATA_REFRESH_INFLIGHT.discard(key)


def _refresh_hot_quotes():
    now = time.time()

    def _refresh(mode_key: str, source: Dict[str, float], include_prepost: bool):
        with _REFRESH_LOCK:
            hot_symbols = [
                symbol
                for symbol, last_seen in source.items()
                if now - last_seen <= _HOT_QUOTES_TTL
            ]
            for symbol in list(source.keys()):
                if now - source[symbol] > _HOT_QUOTES_TTL:
                    source.pop(symbol, None)
        if not hot_symbols:
            return
        cache_key = f"{mode_key}:" + ",".join(sorted(hot_symbols))
        entry = _cache_peek(_DATA_CACHE, f"quotes:{cache_key}")
        if entry and not _cache_is_stale(entry, _QUOTE_TTL):
            return
        with _REFRESH_LOCK:
            if cache_key in _QUOTE_REFRESH_INFLIGHT:
                return
            _QUOTE_REFRESH_INFLIGHT.add(cache_key)
        try:
            quotes = _get_quote_snapshot(hot_symbols, include_prepost=include_prepost)
            if quotes:
                _cache_set(_DATA_CACHE, f"quotes:{cache_key}", quotes)
        except Exception:
            pass
        finally:
            with _REFRESH_LOCK:
                _QUOTE_REFRESH_INFLIGHT.discard(cache_key)

    _refresh("rth", _HOT_QUOTES_RTH, False)
    _refresh("ext", _HOT_QUOTES_EXT, True)


def _refresh_loop():
    while not _STOP_EVENT.is_set():
        _refresh_hot_data()
        _refresh_hot_quotes()
        _STOP_EVENT.wait(_REFRESH_TICK)


@app.on_event("startup")
def _on_startup():
    thread = Thread(target=_refresh_loop, daemon=True)
    thread.start()


@app.on_event("shutdown")
def _on_shutdown():
    _STOP_EVENT.set()

def _get_symbol_meta(symbol: str) -> Dict[str, object]:
    cached = _cache_get(_META_CACHE, symbol, _META_TTL)
    if cached is not None:
        return cached
    exchange = ""
    quote_type = ""
    name = ""
    currency = ""
    prev_close = None
    try:
        info = yf.Ticker(symbol).info
        exchange = info.get("exchange") or info.get("fullExchangeName") or ""
        quote_type = info.get("quoteType") or ""
        name = info.get("shortName") or info.get("longName") or info.get("displayName") or ""
        currency = info.get("currency") or ""
        prev_close = info.get("regularMarketPreviousClose") or info.get("previousClose")
    except Exception:
        exchange = ""
        quote_type = ""
        name = ""
        currency = ""
        prev_close = None
    meta = {
        "exchange": exchange,
        "quote_type": quote_type,
        "name": name,
        "currency": currency,
        "prev_close": prev_close,
    }
    _cache_set(_META_CACHE, symbol, meta)
    return meta


def _is_24_7(symbol: str) -> bool:
    meta = _get_symbol_meta(symbol)
    quote_type = (meta.get("quote_type") or "").upper()
    if quote_type in {"CRYPTOCURRENCY", "CRYPTO"}:
        return True
    upper = symbol.upper()
    return any(
        upper.endswith(suffix)
        for suffix in ("-USD", "-USDT", "-USDC", "-BTC", "-ETH", "=F")
    )


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "ts": datetime.utcnow().isoformat(),
        "auth_enabled": _AUTH_ENABLED,
        "rate_limit_enabled": _RATE_LIMIT_ENABLED and _RATE_LIMIT_RPM > 0,
    }


@app.get("/api/data/{symbol}")
def get_symbol_data(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
):
    return _get_chart_data_payload(symbol, tf, ext)


@app.get("/api/chart/data/{symbol}")
def get_chart_symbol_data(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
):
    return _get_chart_data_payload(symbol, tf, ext)


@app.get("/api/data_delta/{symbol}")
def get_symbol_data_delta(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
    since: int = Query(0, description="Unix timestamp of last known bar"),
):
    return _get_chart_data_delta_payload(symbol, tf, ext, since)


@app.get("/api/chart/data_delta/{symbol}")
def get_chart_symbol_data_delta(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
    since: int = Query(0, description="Unix timestamp of last known bar"),
):
    return _get_chart_data_delta_payload(symbol, tf, ext, since)


@app.get("/api/stream/data/{symbol}")
def stream_symbol_data(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
    since: int = Query(0, description="Unix timestamp of last known bar"),
):
    return _stream_chart_data_response(symbol, tf, ext, since)


@app.get("/api/chart/stream/data/{symbol}")
def stream_chart_symbol_data(
    symbol: str,
    tf: str = Query("5m", description="Timeframe, e.g. 1m,5m,15m,1h,4h,1d,1w"),
    ext: bool = Query(False, description="Include extended hours"),
    since: int = Query(0, description="Unix timestamp of last known bar"),
):
    return _stream_chart_data_response(symbol, tf, ext, since)


@app.get("/api/prewarm")
def prewarm_chart_data(
    symbols: str = Query("", description="Comma separated symbols"),
    tf: str = Query("1h", description="Timeframe to prewarm"),
    ext: bool = Query(False, description="Include extended hours"),
):
    sym_list = [_normalize_symbol(s) for s in symbols.split(",") if s.strip()]
    sym_list = [s for s in sym_list if s]
    if not sym_list:
        return {"warmed": 0, "symbols": []}
    if len(sym_list) > 20:
        sym_list = sym_list[:20]
    tf = tf.lower()
    warmed = 0
    failed: List[str] = []
    unique_symbols = list(dict.fromkeys(sym_list))
    for symbol in unique_symbols:
        try:
            _get_cached_symbol_payload(symbol, tf, ext)
            warmed += 1
        except Exception:
            failed.append(symbol)
    return {
        "warmed": warmed,
        "symbols": unique_symbols,
        "failed": failed,
        "tf": tf,
        "ext": ext,
    }


@app.get("/api/news")
def get_news(
    symbol: str = Query(..., min_length=1, max_length=20),
    limit: int = Query(3, ge=1, le=10),
):
    """
    Ticker-specific news from a public feed.

    This endpoint intentionally avoids external service credentials so the charts
    iframe can always render with ticker headlines.
    """
    sym = "".join(ch for ch in symbol.upper() if ch.isalnum() or ch in "-.")
    if not sym:
        return {
            "symbol": symbol,
            "items": [],
            "last_updated": datetime.utcnow().isoformat(),
        }

    rss_url = (
        "https://news.google.com/rss/search"
        f"?q={sym}%20stock&hl=en-US&gl=US&ceid=US:en"
    )
    try:
        request_obj = urllib_request.Request(
            rss_url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; WhompCharts/1.0)"},
        )
        with urllib_request.urlopen(request_obj, timeout=8) as response:
            xml_payload = response.read().decode("utf-8", errors="ignore")
        root = ET.fromstring(xml_payload)
    except Exception:
        return {
            "symbol": sym,
            "items": [],
            "last_updated": datetime.utcnow().isoformat(),
        }

    items = []
    for node in root.findall(".//item")[:limit]:
        title = (node.findtext("title", "") or "").strip()
        if not title:
            continue
        if " - " in title:
            title = title.rsplit(" - ", 1)[0].strip()
        link = (node.findtext("link", "") or "").strip()
        source_elem = node.find("source")
        source = (source_elem.text or "").strip() if source_elem is not None else "Google News"
        pub_date = (node.findtext("pubDate", "") or "").strip()
        try:
            published_at = parsedate_to_datetime(pub_date).isoformat()
        except Exception:
            published_at = datetime.utcnow().isoformat()
        items.append(
            {
                "ticker": sym,
                "title": title,
                "source": source,
                "time": published_at,
                "url": link,
            }
        )

    return {
        "symbol": sym,
        "items": items,
        "last_updated": datetime.utcnow().isoformat(),
    }


@app.get("/api/symbols")
def search_symbols(query: str = Query("", min_length=1)):
    q = query.strip().upper()
    if not q:
        return {"query": query, "results": []}

    cached = _cache_get(_SEARCH_CACHE, q, _SEARCH_TTL)
    if cached is not None:
        return {"query": query, "results": cached}

    try:
        data = _requests_json_with_retry(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": q, "quotesCount": 10, "newsCount": 0},
            retries=2,
            timeout=8,
        )
    except Exception:
        return {"query": query, "results": [], "error": "search_failed"}
    results = []
    for item in data.get("quotes", []):
        results.append(
            {
                "symbol": item.get("symbol", ""),
                "name": item.get("shortname") or item.get("longname") or "",
                "exchange": item.get("exchange", ""),
                "type": item.get("quoteType", ""),
            }
        )

    _cache_set(_SEARCH_CACHE, q, results)
    return {"query": query, "results": results}


@app.get("/api/quotes")
def get_quotes(
    symbols: str = Query("", description="Comma separated symbols"),
    ext: bool = Query(False, description="Include pre/post"),
):
    sym_list = [_normalize_symbol(s) for s in symbols.split(",") if s.strip()]
    sym_list = [s for s in sym_list if s]
    if not sym_list:
        return {"quotes": {}, "stale": False}
    if len(sym_list) > 50:
        sym_list = sym_list[:50]
    sym_list = sorted(sym_list)
    _mark_hot_quotes(sym_list, include_prepost=ext)

    mode_key = "ext" if ext else "rth"
    cache_key = f"{mode_key}:" + ",".join(sym_list)
    entry = _cache_peek(_DATA_CACHE, f"quotes:{cache_key}")
    if entry and not _cache_is_stale(entry, _QUOTE_TTL):
        return {"quotes": entry["value"], "stale": False}
    if entry and _cache_is_stale(entry, _QUOTE_TTL):
        return {"quotes": entry["value"], "stale": True}

    quotes = _get_quote_snapshot(sym_list, include_prepost=ext)
    if not quotes and entry:
        return {"quotes": entry["value"], "stale": True}
    _cache_set(_DATA_CACHE, f"quotes:{cache_key}", quotes)
    return {"quotes": quotes, "stale": False}


@app.get("/api/stream/quotes")
def stream_quotes(
    symbols: str = Query("", description="Comma separated symbols"),
    ext: bool = Query(False, description="Include pre/post"),
):
    sym_list = [_normalize_symbol(s) for s in symbols.split(",") if s.strip()]
    sym_list = [s for s in sym_list if s]
    if not sym_list:
        raise HTTPException(status_code=400, detail="No symbols")
    if len(sym_list) > 50:
        sym_list = sym_list[:50]
    sym_list = sorted(sym_list)
    _mark_hot_quotes(sym_list, include_prepost=ext)

    def event_stream():
        last_payload: Optional[Dict[str, object]] = None
        while not _STOP_EVENT.is_set():
            mode_key = "ext" if ext else "rth"
            cache_key = f"{mode_key}:" + ",".join(sym_list)
            entry = _cache_peek(_DATA_CACHE, f"quotes:{cache_key}")
            stale = False
            if not entry or _cache_is_stale(entry, _QUOTE_TTL):
                payload = _get_quote_snapshot(sym_list, include_prepost=ext)
                if payload:
                    _cache_set(_DATA_CACHE, f"quotes:{cache_key}", payload)
                    stale = False
                elif entry:
                    payload = entry["value"]
                    stale = True
                else:
                    payload = {}
                    stale = True
            else:
                payload = entry["value"]
                stale = False
            event_payload = {"quotes": payload, "stale": stale}
            if event_payload != last_payload:
                last_payload = event_payload
                yield f"data: {json.dumps(event_payload)}\n\n"
            _STOP_EVENT.wait(_QUOTE_TTL)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
