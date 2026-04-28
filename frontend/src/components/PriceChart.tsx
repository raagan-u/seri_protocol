import { useEffect, useRef } from "react";
import {
  AreaSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint } from "../api/types";

export type ChartStyle = "area" | "line" | "stepped";

// Color palette matches the rest of the UI (defined in CSS vars in index.css).
// lightweight-charts needs literal strings, so they're hardcoded here.
const COLORS = {
  bg: "#0E0F12",
  text: "rgba(229, 231, 235, 0.9)",
  textDim: "rgba(229, 231, 235, 0.45)",
  grid: "rgba(255, 255, 255, 0.06)",
  border: "rgba(255, 255, 255, 0.10)",
  accent: "#7FE0C2",
  accentBg: "rgba(127, 224, 194, 0.14)",
};

export function PriceChart({
  data,
  height = 280,
  style = "area",
  floorPrice,
  showAxes = true,
  onHover,
}: {
  data: PricePoint[];
  height?: number;
  style?: ChartStyle;
  floorPrice?: number;
  maxPrice?: number;
  showAxes?: boolean;
  live?: boolean;
  onHover?: (p: PricePoint | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Line"> | null>(null);
  const floorLineRef = useRef<IPriceLine | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  // --- Mount: create chart + series. Re-runs only on `style` / `showAxes` change.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: COLORS.textDim,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "transparent" },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: {
        visible: showAxes,
        borderColor: COLORS.border,
      },
      timeScale: {
        visible: showAxes,
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: COLORS.textDim, width: 1, style: 3, labelVisible: false },
        horzLine: { color: COLORS.textDim, width: 1, style: 3, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const seriesOpts = {
      lineColor: COLORS.accent,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    };
    const series =
      style === "line" || style === "stepped"
        ? chart.addSeries(LineSeries, {
            ...seriesOpts,
            lineType: style === "stepped" ? 1 : 0,
          })
        : chart.addSeries(AreaSeries, {
            ...seriesOpts,
            topColor: COLORS.accentBg,
            bottomColor: "rgba(127, 224, 194, 0)",
          });
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      const cb = onHoverRef.current;
      if (!cb) return;
      if (!param.time || !seriesRef.current) {
        cb(null);
        return;
      }
      const v = param.seriesData.get(seriesRef.current) as LineData | undefined;
      if (v && typeof v.value === "number") {
        cb({
          t: Number(param.time),
          price: v.value,
          timestamp: Number(param.time),
        });
      } else {
        cb(null);
      }
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [style, showAxes]);

  // --- Push data updates to the existing series.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const points: LineData<UTCTimestamp>[] = data
      .map((p) => ({
        time: ((p.timestamp ?? p.t) as number) as UTCTimestamp,
        value: p.price,
      }))
      // de-dupe identical timestamps (lightweight-charts requires strictly increasing time)
      .filter((p, i, arr) => i === 0 || p.time !== arr[i - 1].time)
      .sort((a, b) => (a.time as number) - (b.time as number));
    series.setData(points);

    if (floorLineRef.current) {
      series.removePriceLine(floorLineRef.current);
      floorLineRef.current = null;
    }
    if (floorPrice !== undefined && floorPrice > 0 && points.length > 0) {
      floorLineRef.current = series.createPriceLine({
        price: floorPrice,
        color: COLORS.textDim,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: showAxes,
        title: "Floor",
      });
    }

    if (chartRef.current && points.length > 0) {
      chartRef.current.timeScale().fitContent();
    }
  }, [data, floorPrice, showAxes]);

  return (
    <div
      ref={wrapRef}
      style={{ width: "100%", height, position: "relative" }}
    />
  );
}

export function Sparkline({
  data,
  width = 120,
  height = 28,
  color = "var(--accent)",
}: {
  data: PricePoint[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length === 0) return <svg width={width} height={height} />;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = data
    .map((d, i) => `${(i / (data.length - 1)) * width},${(1 - (d.price - min) / range) * height}`)
    .join(" ");
  return (
    <svg width={width} height={height}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}
