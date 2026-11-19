import type { CSSProperties } from 'react';
import './loading.css';

// Original SVG/CSS adaptation of the supplied character-and-sticky-notes reference.
// No third-party media, animation library, or simulated loading delay is used.
const notes = [
  [65, 87, -12], [96, 89, 9], [81, 72, 7], [57, 71, -8],
  [104, 72, 15], [69, 53, -14], [90, 52, 12], [82, 38, -6],
  [53, 93, 14], [111, 91, -10], [74, 96, 5], [96, 105, -8],
];

export function LoadingAnimation({ label = 'Loading your workspace…', compact = false }: {
  label?: string; compact?: boolean;
}) {
  return <div className={`loading-state${compact ? ' loading-state-compact' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    <svg className="loading-scene" viewBox="0 0 180 150" aria-hidden="true" focusable="false">
      <path className="loader-desk" d="M28 124c32-1 88-1 124 0" />
      <g className="loader-person">
        <path fill="#242724" d="M44 122c0-24 9-47 28-51l35 1c21 6 29 27 29 50Z" />
        <path fill="#fffefa" stroke="#242724" strokeWidth="2" d="m79 65-1 10c4 10 20 10 25 0l-2-12" />
        <path fill="#242724" d="M68 47c-2-21 14-32 29-27 16 0 22 15 16 34l-7 12-34-4Z" />
        <path fill="#fffefa" stroke="#242724" strokeWidth="2" d="M77 42c-4 15-1 31 12 33 14 2 20-15 18-28-7-1-12-5-15-10-3 6-8 8-15 5Z" />
        <path fill="none" stroke="#242724" strokeWidth="1.7" strokeLinecap="round" d="m92 51-2 7 4 1m-8 5c3 2 6 2 9 0" />
        <g className="loader-eyes" fill="#242724"><ellipse cx="83" cy="51" rx="1.5" ry="2" /><ellipse cx="100" cy="51" rx="1.5" ry="2" /></g>
        <path fill="none" stroke="#656b62" strokeWidth="1.5" strokeLinecap="round" d="m62 98 6 22m47-23-4 24" />
      </g>
      <g className="loader-notes">
        {notes.map(([x, y, rotation], index) => <g key={index} transform={`translate(${x} ${y}) rotate(${rotation})`}>
          <g className="loader-note" style={{ '--note-delay': `${index * 0.17}s` } as CSSProperties}>
            <path fill="#f1edb4" stroke="#555746" strokeWidth="1.1" strokeLinejoin="round" d="M0 0h17v15l-4 3H0Z" />
            <path fill="none" stroke="#a9a571" strokeWidth=".8" d="M4 5h8M4 8h6m3 10v-3h4" />
          </g>
        </g>)}
      </g>
      <g className="loader-mug">
        <path fill="#fffefa" stroke="#242724" strokeWidth="1.8" d="M101 109h6c10 0 10 13 0 13h-6v-4h5c5 0 5-5 0-5h-5" />
        <path fill="#fffefa" stroke="#242724" strokeWidth="1.8" strokeLinejoin="round" d="m81 105 21 2-2 29-21-2Z" />
        <path fill="none" stroke="#658567" strokeWidth="2" strokeLinecap="round" d="M94 115c-7-5-12 8-4 10l3-1" />
        <path fill="#fffefa" stroke="#242724" strokeWidth="1.6" strokeLinecap="round" d="M72 123c0-5 4-8 9-7l5 2c3 2 1 5-2 4l-3-1m-7 5 7 3c5 1 7-3 4-5l-4-1" />
      </g>
    </svg>
    <p>{label}</p>
  </div>;
}
