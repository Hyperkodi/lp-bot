"use client";

// DexScreener-style candlestick chart (lightweight-charts) with the
// underlying equity price overlaid as a reference line — the visual core of
// the divergence story. Falls back to snapshot-derived candles when live
// DEX data is unavailable (badge shows the source).
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface MarketResponse {
  symbol: string;
  source: "geckoterminal" | "snapshots";
  pool: { address: string; network: string; dex: string | null; liquidityUsd: number | null } | null;
  solanaMint: string | null;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  underlying: { time: number; value: number }[];
}

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

export default function PriceChart({ assetId }: { assetId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1h");
  const [status, setStatus] = useState<"loading" | "ready" | "empty">("loading");
  const [source, setSource] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: { background: { color: "#10151f" }, textColor: "#64748b", fontFamily: "monospace" },
      grid: { vertLines: { color: "#1c2433" }, horzLines: { color: "#1c2433" } },
      timeScale: { borderColor: "#1c2433", timeVisible: true },
      rightPriceScale: { borderColor: "#1c2433" },
      height: 420,
      autoSize: true,
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f87171",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#1c2433",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const underlyingSeries = chart.addSeries(LineSeries, {
      color: "#e8a33d",
      lineWidth: 1,
      lineStyle: 1, // dotted
      priceLineVisible: false,
      lastValueVisible: true,
      title: "underlying",
    });

    (async () => {
      try {
        const res = await fetch(`/api/assets/${assetId}/market?tf=${tf}`);
        const data: MarketResponse = await res.json();
        if (cancelled) return;
        if (!data.candles || data.candles.length === 0) {
          setStatus("empty");
          return;
        }
        candleSeries.setData(
          data.candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
        );
        volumeSeries.setData(
          data.candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume })),
        );
        underlyingSeries.setData(
          data.underlying.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
        );
        chart.timeScale().fitContent();
        setSource(
          data.source === "geckoterminal"
            ? `live · ${data.pool?.dex ?? "dex"} @ ${data.pool?.network ?? ""}`
            : "cached snapshots",
        );
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("empty");
      }
    })();

    return () => {
      cancelled = true;
      chart.remove();
      chartRef.current = null;
    };
  }, [assetId, tf]);

  return (
    <div className="border border-terminal-border bg-terminal-panel">
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`px-2 py-0.5 text-xs ${t === tf ? "bg-terminal-border text-terminal-amber" : "text-terminal-muted hover:text-terminal-text"}`}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-terminal-muted">
          {status === "loading" ? "loading…" : status === "empty" ? "no chart data yet" : source}
        </span>
      </div>
      <div ref={containerRef} className="h-[420px] w-full" />
      <div className="border-t border-terminal-border px-3 py-1.5 text-[10px] text-terminal-muted">
        ── token OHLC · <span className="text-terminal-amber">┄ underlying equity</span> (last stored quote;
        flat outside NYSE hours)
      </div>
    </div>
  );
}
