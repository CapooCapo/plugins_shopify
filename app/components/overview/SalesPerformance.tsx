import { useState } from "react";
import type { OverviewAnalytics } from "../../utils/overview-analytics.server";
import { currencyLabel, dateLabel, numberLabel } from "./format";

type Props = { analytics: OverviewAnalytics; currencyCode: string | null; samplePreview: boolean };
type Measure = "revenue" | "orders" | "units";
type Point = { x: number; y: number; date: string; value: number };

const CHART_WIDTH = 900;
const CHART_HEIGHT = 210;
const CHART_TOP = 12;
const CHART_BOTTOM = CHART_HEIGHT - 8;

function axisStep(maxValue: number) {
  const magnitude = 10 ** Math.floor(Math.log10(maxValue / 3));
  const ratio = maxValue / 3 / magnitude;
  return (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10) * magnitude;
}

function linePath(points: Point[]) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
}

function AnalyticsNotice({ status, message }: { status: string; message?: string }) {
  if (status === "ready") return null;
  const tone = status === "unavailable" ? "stockhub-analytics-notice--error"
    : status === "partial" ? "stockhub-analytics-notice--partial" : "stockhub-analytics-notice--info";
  return <p className={`stockhub-analytics-notice ${tone}`} role={status === "unavailable" ? "alert" : "status"}>
    {message ?? (status === "partial" ? "Some results could not be fully verified." : "This dataset is not available yet.")}
  </p>;
}

export function SalesPerformance({ analytics, currencyCode, samplePreview }: Props) {
  const [measure, setMeasure] = useState<Measure>("revenue");
  const data = analytics.sales.data;
  const daily = data?.daily ?? [];
  const values = daily.map((day) => measure === "revenue" ? day.revenue : measure === "units" ? day.units : day.orders);
  const maxValue = Math.max(0, ...values.filter((value): value is number => value !== null));
  const step = axisStep(maxValue > 0 ? maxValue : 1);
  const axisMax = step * 3;
  const tickValues = [3, 2, 1, 0].map((multiple) => multiple * step);
  const title = measure === "revenue" ? "Net merchandise sales" : measure === "units" ? "Net units sold" : "Orders";
  const formatValue = (value: number | null) => measure === "revenue" ? currencyLabel(value, currencyCode) : value === null ? "Unavailable" : numberLabel(value);
  const formatTick = (value: number) => measure === "revenue" && currencyCode
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode, notation: "compact", maximumFractionDigits: 1 }).format(value)
    : numberLabel(value);
  const currencyNote = samplePreview ? "USD sample currency" : "USD equivalent · daily reference rates";
  const labelStep = analytics.range === 7 ? 1 : 5;
  const segments: Point[][] = [];
  let segment: Point[] = [];
  daily.forEach((day, index) => {
    const value = values[index];
    if (value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({
      x: daily.length === 1 ? CHART_WIDTH / 2 : (index / (daily.length - 1)) * CHART_WIDTH,
      y: CHART_TOP + (1 - value / axisMax) * (CHART_BOTTOM - CHART_TOP),
      date: day.date,
      value,
    });
  });
  if (segment.length) segments.push(segment);

  return <section className="stockhub-overview-panel stockhub-overview-trend" aria-labelledby="overview-trend-title">
    <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
      <div><span className="stockhub-overview-panel-kicker">Sales Performance</span><h2 id="overview-trend-title">Daily trend</h2>
        <p>{analytics.range}-day view · shop-local dates · {analytics.timeZone ?? "time zone unavailable"}</p></div>
      <div className="stockhub-chart-switch" role="group" aria-label="Sales trend measure">
        {(["revenue", "orders", "units"] as const).map((option) => <button key={option} type="button" aria-pressed={measure === option} onClick={() => setMeasure(option)}>
          {option === "revenue" ? "Revenue" : option === "orders" ? "Orders" : "Units"}
        </button>)}
      </div>
    </div>
    <AnalyticsNotice status={analytics.sales.status} message={analytics.sales.message} />
    {!data ? <div className="stockhub-analytics-empty">Sales trend is unavailable until Shopify access and order data can be verified.</div>
      : data.totals.orders === 0 && analytics.sales.status === "ready" ? <div className="stockhub-analytics-empty">No non-cancelled, non-test orders were created in this date range.</div>
        : <>
          <div className="stockhub-chart-measure-label">{title}{measure === "revenue" ? ` · ${currencyNote} · after discounts and returns, before tax` : ""}</div>
          <div className="stockhub-chart-layout">
            <div className="stockhub-chart-y-axis" aria-hidden="true">
              {tickValues.map((value) => <span key={value}>{formatTick(value)}</span>)}
            </div>
            <div className="stockhub-chart-visual">
              <svg className="stockhub-chart-plot" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none"
                role="img" aria-label={`${title} by shop-local date. Vertical axis: ${measure === "revenue" ? currencyCode ?? "store currency unavailable" : measure}.`}>
                <title>{title} by day</title>
                <desc>Numeric vertical axis from {formatTick(axisMax)} to {formatTick(0)}; the accessible daily values follow the chart.</desc>
                {tickValues.map((value, index) => {
                  const y = CHART_TOP + (index / (tickValues.length - 1)) * (CHART_BOTTOM - CHART_TOP);
                  return <line key={value} className="stockhub-chart-gridline" x1="0" x2={CHART_WIDTH} y1={y} y2={y} />;
                })}
                {segments.map((points, index) => {
                  const areaPath = `${linePath(points)} L${points.at(-1)!.x},${CHART_BOTTOM} L${points[0].x},${CHART_BOTTOM} Z`;
                  return <g key={`${points[0].date}-${index}`}>
                    <path className={`stockhub-chart-area stockhub-chart-area--${measure}`} d={areaPath} />
                    <path className={`stockhub-chart-line stockhub-chart-line--${measure}`} d={linePath(points)} />
                    {points.map((point) => <circle key={point.date} className={`stockhub-chart-point stockhub-chart-point--${measure}`} cx={point.x} cy={point.y} r="3.5">
                      <title>{`${dateLabel(point.date)}: ${formatValue(point.value)}`}</title>
                    </circle>)}
                  </g>;
                })}
              </svg>
              <div className="stockhub-chart-x-axis" style={{ gridTemplateColumns: `repeat(${daily.length}, minmax(0, 1fr))` }} aria-hidden="true">
                {daily.map((day, index) => <span key={day.date}>{index % labelStep === 0 || index === daily.length - 1 ? dateLabel(day.date) : ""}</span>)}
              </div>
            </div>
          </div>
          <ul className="stockhub-visually-hidden" aria-label={`${title} daily values`}>
            {daily.map((day, index) => <li key={day.date}>{dateLabel(day.date)}: {formatValue(values[index])}</li>)}
          </ul>
        </>}
  </section>;
}
