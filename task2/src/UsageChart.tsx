import { useEffect, useRef, useState } from 'react';
import { Chart, CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip } from 'chart.js';
import type { Summary } from './api';

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip);
export const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function UsageChart({ summary }: { summary: Summary }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [metric, setMetric] = useState<'minutes' | 'sms' | 'cost_cents'>('minutes');
  useEffect(() => {
    if (!canvas.current) return;
    const chart = new Chart(canvas.current, {
      type: 'line',
      data: { labels: summary.series.map((point) => point.date), datasets: [{
        data: summary.series.map((point) => metric === 'cost_cents' ? point[metric] / 100 : point[metric]),
        borderColor: '#357762', borderWidth: 2, backgroundColor: '#35776212',
        pointRadius: 0, pointHitRadius: 12, fill: true, tension: 0.25,
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { displayColors: false } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: '#7c8580',
            maxTicksLimit: 7, maxRotation: 0, callback(value) {
              return this.getLabelForValue(Number(value)).slice(5).replace('-', '/');
            } } },
          y: { beginAtZero: true, border: { display: false }, grid: { color: '#edf0ec' },
            ticks: { color: '#7c8580', maxTicksLimit: 5 } },
        },
      },
    });
    return () => chart.destroy();
  }, [summary, metric]);
  const total = summary.series.reduce((sum, point) => sum + point[metric], 0);
  return <>
    <div className="chart-controls">
      <div><span className="eyebrow">Daily activity</span><h3>{metric === 'cost_cents' ? money(total) : number(total)} <span>{metric === 'minutes' ? 'minutes' : metric === 'sms' ? 'messages' : 'USD'}</span></h3></div>
      <fieldset className="segmented"><legend className="sr-only">Chart metric</legend>
        {(['minutes', 'sms', 'cost_cents'] as const).map((value) => <label key={value} className={metric === value ? 'chosen' : ''}>
          <input className="sr-only" type="radio" name="metric" checked={metric === value} onChange={() => setMetric(value)} />
          {value === 'minutes' ? 'Minutes' : value === 'sms' ? 'SMS' : 'Cost'}
        </label>)}
      </fieldset>
    </div>
    <div className="chart-canvas"><canvas ref={canvas} role="img" aria-label={`Daily ${metric === 'cost_cents' ? 'cost in US dollars' : metric}; total ${metric === 'cost_cents' ? money(total) : number(total)}. Expand daily values for the full data.`} /></div>
    <details className="chart-values"><summary>View daily values</summary><div className="values-scroll"><table>
      <caption className="sr-only">Daily usage values</caption><thead><tr><th>Date</th><th>Minutes</th><th>SMS</th><th>Cost (USD)</th></tr></thead>
      <tbody>{summary.series.map((point) => <tr key={point.date}><td>{point.date}</td><td>{number(point.minutes)}</td><td>{number(point.sms)}</td><td>{money(point.cost_cents)}</td></tr>)}</tbody>
    </table></div></details>
  </>;
}
