"use client";

// Premium/discount history (bps) from our hourly snapshots, with ±flag
// threshold lines and market-hours shading: faint columns mark periods when
// NYSE was closed, where divergence is price discovery rather than
// arbitrageable spread. Server component passes the series in as props.
import { useEffect, useRef } from "react";
import { createChart, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";

export default function PremiumChart({
  points,
  flagBps,
}: {
  points: { time: number; value: number; marketOpen: boolean }[];
  flagBps: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const chart = createChart(el, {
      layout: { background: { color: "#10151f" }, textColor: "#64748b", fontFamily: "monospace" },
      grid: { vertLines: { color: "#1c2433" }, horzLines: { color: "#1c2433" } },
      timeScale: { borderColor: "#1c2433", timeVisible: true },
      rightPriceScale: { borderColor: "#1c2433" },
      height: 180,
      autoSize: true,
    });

    // Closed-market shading: full-height translucent columns on a hidden scale.
    const shading = chart.addSeries(HistogramSeries, {
      priceScaleId: "shade",
      color: "rgba(100, 116, 139, 0.12)",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("shade").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    shading.setData(
      points.map((p) => ({ time: p.time as UTCTimestamp, value: p.marketOpen ? 0 : 1 })),
    );

    const series = chart.addSeries(LineSeries, { color: "#e8a33d", lineWidth: 2, priceLineVisible: false });
    series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    series.createPriceLine({ price: flagBps, color: "#f87171", lineStyle: 2, lineWidth: 1, title: `+${flagBps}` });
    series.createPriceLine({ price: -flagBps, color: "#f87171", lineStyle: 2, lineWidth: 1, title: `-${flagBps}` });
    series.createPriceLine({ price: 0, color: "#64748b", lineStyle: 3, lineWidth: 1, title: "" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, flagBps]);

  if (points.length === 0) {
    return (
      <p className="px-3 py-6 text-xs text-terminal-muted">
        Premium history builds up as hourly snapshots accumulate.
      </p>
    );
  }
  return (
    <div>
      <div ref={ref} className="h-[180px] w-full" />
      <p className="px-3 py-1.5 text-[10px] text-terminal-muted">
        shaded columns = NYSE closed (off-hours price discovery) · red dashes = ±{flagBps}bps flag
      </p>
    </div>
  );
}
