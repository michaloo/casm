import { useState } from "react";
import type { ProviderCosts } from "@casm/protocol";
import { ProviderIcon, providerNames } from "./provider-icon";

// "$0" for nothing, four decimals under a cent (agents' spend is often tiny), else cents.
export function usd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

// The server's YYYY-MM-DD as a calendar day (its weekday doesn't depend on our zone).
const day = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const weekday = (date: string) => day(date).toLocaleDateString([], { weekday: "short" });
const longDay = (date: string) => day(date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

const HEIGHT = 72;

/** One agent provider's estimated cost per day: a bar per day, today highlighted, the value on hover or tap. */
export function CostCard({ costs, today }: { costs: ProviderCosts; today: string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const name = providerNames[costs.provider];
  const days = costs.days;
  const max = Math.max(...days.map((d) => d.costUsd));
  const todayAt = days.findIndex((d) => d.date === today);
  const shown = picked ?? (todayAt >= 0 ? todayAt : days.length - 1);
  const label = (i: number) => (days[i].date === today ? "Today" : longDay(days[i].date));
  const top = days.reduce((best, d, i) => (d.costUsd > days[best].costUsd ? i : best), 0);
  const summary = `Estimated cost per day over the last ${days.length} days, ${usd(costs.totalUsd)} in total; highest ${label(top)} at ${usd(days[top].costUsd)}`;
  const width = 100 / days.length;
  return <section className="host-provider-usage usage-card cost-card" aria-label={`${name} estimated cost`}>
    <div className="usage-card-head">
      <strong><ProviderIcon provider={costs.provider} /> {name}</strong>
      <span className="chip" title={`Estimated total over the last ${days.length} days`}>{days.length} days · {usd(costs.totalUsd)}</span>
    </div>
    <div className="usage-window-values cost-readout" aria-hidden="true">
      <span>{label(shown)}</span><span>{usd(days[shown].costUsd)}</span>
    </div>
    <div className="cost-chart" onPointerLeave={(e) => e.pointerType === "mouse" && setPicked(null)}>
      <svg role="img" aria-label={summary} width="100%" height={HEIGHT}>
        {picked !== null && <rect className="cost-band" x={`${picked * width}%`} width={`${width}%`} y="0" height={HEIGHT} rx="6" />}
        <line className="cost-base" x1="0" x2="100%" y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
        <svg width="100%" height={HEIGHT - 1} overflow="hidden">
          {days.map((d, i) => {
            const h = max > 0 && d.costUsd > 0 ? Math.max(3, (d.costUsd / max) * (HEIGHT - 6)) : 0;
            return <rect key={d.date} className={`cost-bar${d.date === today ? " today" : ""}${i === shown && picked !== null ? " picked" : ""}`}
              x={`${i * width + width * 0.18}%`} width={`${width * 0.64}%`} y={HEIGHT - 1 - h} height={h ? h + 4 : 0} rx="4" />;
          })}
        </svg>
        {/* Hit targets: the whole column, bigger than the bar. */}
        {days.map((d, i) => <rect key={d.date} className="cost-hit" data-date={d.date} x={`${i * width}%`} width={`${width}%`} y="0" height={HEIGHT}
          onPointerEnter={(e) => e.pointerType === "mouse" && setPicked(i)} onClick={() => setPicked((p) => (p === i ? null : i))} />)}
      </svg>
      <div className="cost-days" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d) => <span key={d.date} className={d.date === today ? "today" : undefined}>{d.date === today ? "Today" : weekday(d.date)}</span>)}
      </div>
    </div>
    <table className="visually-hidden">
      <caption>{name} estimated cost per day</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">Estimated cost</th></tr></thead>
      <tbody>{days.map((d) => <tr key={d.date}><th scope="row">{d.date === today ? `Today, ${longDay(d.date)}` : longDay(d.date)}</th><td>{usd(d.costUsd)}</td></tr>)}</tbody>
    </table>
    <small className="usage-reported" title="The agent's own estimate: its catalog price × tokens, not a bill. Free and local models count as $0.">
      Estimated, as reported by {name} · {costs.agents} agent{costs.agents === 1 ? "" : "s"}{costs.error ? ` · ${costs.error}` : ""}
    </small>
  </section>;
}
