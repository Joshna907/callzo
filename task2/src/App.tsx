import { useCallback, useEffect, useState } from 'react';
import { decodeAccounts, decodeSummary, stabilizeAccounts } from './api';
import { useRemote } from './useRemote';
import { readQuery, summaryParams, tableParams, togglePageSelection, type Query, type SortKey } from './query';
import { Accounts } from './Accounts';
import { UsageChart, money, number } from './UsageChart';
import { LoadingAnimation } from './LoadingAnimation';
import { SettingsDialog } from './SettingsDialog';

function accountFromUrl() {
  const value = new URLSearchParams(window.location.search).get('account');
  const id = Number(value);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function Search({ value, commit }: { value: string; commit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => commit(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft, value, commit]);
  return <label className="search-field"><span className="sr-only">Search name, email, or company</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
    <input type="search" placeholder="Search accounts…" value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)} /></label>;
}
function DateRange({ query, commit }: { query: Query; commit: (patch: Partial<Query>) => void }) {
  const [from, setFrom] = useState(query.date_from);
  const [to, setTo] = useState(query.date_to);
  useEffect(() => { setFrom(query.date_from); setTo(query.date_to); }, [query.date_from, query.date_to]);
  return <form className="date-range" onSubmit={(event) => { event.preventDefault(); if (!from || !to || from <= to) commit({ date_from: from, date_to: to, page: 1 }); }}>
    <label><span>From</span><input aria-label="Signup date from" type="date" value={from} max={to || '9999-12-31'} onChange={(event) => setFrom(event.target.value)} /></label>
    <span className="date-divider" aria-hidden="true">—</span>
    <label><span>To</span><input aria-label="Signup date to" type="date" value={to} min={from || '0001-01-01'} onChange={(event) => setTo(event.target.value)} /></label>
    <button className="button button-small" type="submit">Apply</button>
    <button type="button" className="text-button" onClick={() => {
      const year = new Date().getUTCFullYear();
      const date_from = `${year}-01-01`; const date_to = `${year}-12-31`;
      setFrom(date_from); setTo(date_to); commit({ date_from, date_to, page: 1 });
    }}>This year</button>
    {(from || to) && <button type="button" className="text-button" onClick={() => { setFrom(''); setTo(''); commit({ date_from: '', date_to: '', page: 1 }); }}>Clear dates</button>}
  </form>;
}
function ErrorNotice({ message, retry, retained = false }: { message: string; retry: () => void; retained?: boolean }) {
  return <div className="error-notice" role="status"><div><strong>{retained ? 'Refresh paused' : 'Couldn’t load this section'}</strong><p>{message} {retained && 'Showing the last successful results.'}</p></div><button className="button button-small" onClick={retry}>Retry</button></div>;
}

export function App() {
  const [query, setQuery] = useState(() => readQuery(window.location.search));
  const [selected, setSelected] = useState(new Set<number>());
  const [editingId, setEditingId] = useState(accountFromUrl);
  useEffect(() => {
    const pop = () => { setQuery(readQuery(window.location.search)); setEditingId(accountFromUrl()); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const change = useCallback((patch: Partial<Query>, replace = false) => {
    const next = { ...query, ...patch };
    const params = new URLSearchParams(tableParams(next));
    if (editingId) params.set('account', String(editingId));
    window.history[replace ? 'replaceState' : 'pushState'](null, '', `?${params}${window.location.hash}`);
    setQuery(next);
  }, [query, editingId]);
  const openSettings = (id: number) => {
    const params = new URLSearchParams(window.location.search); params.set('account', String(id));
    window.history.pushState(null, '', `?${params}${window.location.hash}`); setEditingId(id);
  };
  const closeSettings = () => {
    const params = new URLSearchParams(window.location.search); params.delete('account');
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
    setEditingId(null);
  };
  const search = useCallback((value: string) => change({ search: value, page: 1 }, true), [change]);
  const accounts = useRemote(`/accounts?${tableParams(query)}`, decodeAccounts, stabilizeAccounts);
  const summary = useRemote(`/accounts/summary?${summaryParams(query)}`, decodeSummary);
  const [initialLoading, setInitialLoading] = useState(true);
  useEffect(() => {
    // Release the page when accounts settle, even if the chart is slow or fails.
    if (!accounts.busy) setInitialLoading(false);
  }, [accounts.busy]);
  const totals = summary.data?.series.reduce((sum, point) => ({ minutes: sum.minutes + point.minutes, sms: sum.sms + point.sms, cost: sum.cost + point.cost_cents }), { minutes: 0, sms: 0, cost: 0 });
  const toggle = (id: number) => setSelected((previous) => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const sort = (sort_by: SortKey) => change({ sort_by, sort_dir: query.sort_by === sort_by && query.sort_dir === 'desc' ? 'asc' : 'desc', page: 1 });
  const activeFilters = Boolean(query.search || query.status || query.plan || query.country || query.date_from || query.date_to);
  const pageCount = accounts.data ? Math.max(1, Math.ceil(accounts.data.total / query.page_size)) : query.page;
  useEffect(() => {
    if (accounts.data && query.page > pageCount) change({ page: pageCount }, true);
  }, [accounts.data, query.page, pageCount, change]);
  return <>
    {initialLoading && <div className="workspace-loading"><LoadingAnimation /></div>}
    <div className="app-shell" inert={initialLoading}>
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar"><a className="brand" href="#overview" aria-label="Callzo overview"><span className="brand-mark" aria-hidden="true">c</span>callzo<span className="brand-dot">.</span></a>
      <div className="workspace"><span className="workspace-avatar">C</span><div><strong>Callzo workspace</strong><span>Administration</span></div><span aria-hidden="true">⌄</span></div>
      <p className="nav-label">WORKSPACE</p><nav aria-label="Workspace navigation"><a className="nav-active" href="#overview"><span aria-hidden="true">▦</span> Usage overview</a><a href="#accounts"><span aria-hidden="true">▤</span> Accounts</a></nav>
      <div className="sidebar-bottom"><span className="workspace-avatar admin-avatar">AD</span><div><strong>Admin workspace</strong><span>Assessment environment</span></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="breadcrumb-slash">/</span><strong>Usage overview</strong></div><span className="environment">Demo environment</span></header>
      <main id="main" tabIndex={-1}>
        <section id="overview" className="page-heading"><div><p className="eyebrow">WORKSPACE ANALYTICS</p><h1>Usage overview<span>.</span></h1><p>Keep a pulse on your accounts and every conversation.</p></div>
          <button className="button" onClick={() => { accounts.retry(); summary.retry(); }} disabled={accounts.busy && summary.busy}><span aria-hidden="true">↻</span> Refresh data</button></section>
        <div className="period-row"><div><h2>Workspace activity</h2><p>Filter by signup date. The same range updates accounts and the chart.</p></div><DateRange query={query} commit={change} /></div>
        <div className="metrics-grid" aria-label="Usage summary">
          {[
            ['Accounts in range', summary.data ? number(summary.data.total_accounts) : '—', 'Matching the date range', '↗'],
            ['Call minutes', totals ? number(totals.minutes) : '—', 'Across the daily series', '◷'],
            ['Messages sent', totals ? number(totals.sms) : '—', 'Across the daily series', '▤'],
            ['Usage cost', totals ? money(totals.cost) : '—', 'US dollars · selected range', '$'],
          ].map(([label, value, note, symbol]) => <article className="metric" key={label}><div className="metric-label">{label}<span aria-hidden="true">{symbol}</span></div><strong>{value}</strong><p>{note}</p></article>)}
        </div>
        <section className="panel chart-panel" aria-labelledby="chart-heading"><div className="section-heading"><div><h2 id="chart-heading">Usage over time</h2><p>Daily totals for the date range. Account search and filters apply to the table.</p></div><span className="live-label"><i aria-hidden="true" /> {summary.busy ? 'Updating' : summary.error ? 'Needs retry' : 'Daily totals'}</span></div>
          {summary.error && <ErrorNotice message={summary.error} retry={summary.retry} retained={Boolean(summary.data)} />}
          {summary.data ? summary.data.series.length ? <UsageChart summary={summary.data} /> : <div className="empty-state chart-empty"><h3>No activity in this range</h3><p>Choose another date range to explore usage.</p></div>
            : !summary.error && <LoadingAnimation compact label="Loading usage summary…" />}
        </section>
        <section id="accounts" className="panel accounts-panel" aria-labelledby="accounts-heading"><div className="section-heading"><div className="accounts-title"><h2 id="accounts-heading">Accounts</h2>{accounts.data && <span className="count-badge">{number(accounts.data.total)}</span>}<p>Usage at a glance, with your selection kept across pages.</p></div>
          <span className={`live-label ${accounts.error ? 'connection-error' : ''}`} aria-live="polite"><i aria-hidden="true" />{accounts.busy ? 'Updating…' : accounts.error ? 'Refresh failed' : accounts.updatedAt ? `Synced ${new Date(accounts.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting'}</span></div>
          <div className="filter-bar"><Search value={query.search} commit={search} /><div className="select-filters">
            <label><span className="sr-only">Filter account status</span><select value={query.status} onChange={(event) => change({ status: event.target.value, page: 1 })}><option value="">All statuses</option><option value="active">Active</option><option value="trial">Trial</option><option value="suspended">Suspended</option></select></label>
            <label><span className="sr-only">Filter account plan</span><select value={query.plan} onChange={(event) => change({ plan: event.target.value, page: 1 })}><option value="">All plans</option><option value="basic">Basic</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></label>
            <label><span className="sr-only">Filter country</span><select value={query.country} onChange={(event) => change({ country: event.target.value, page: 1 })}><option value="">All countries</option>{[...new Set(['US', 'IN', 'GB', 'CA', 'AU', 'DE', 'FR', 'BR', 'NG', 'PK', ...(query.country ? [query.country] : [])])].map((code) => <option key={code}>{code}</option>)}</select></label>
          </div>{activeFilters && <button className="text-button" onClick={() => change({ search: '', status: '', country: '', plan: '', date_from: '', date_to: '', page: 1 })}>Reset filters</button>}</div>
          <div className="selection-bar"><span>{selected.size ? `${number(selected.size)} selected across pages` : 'Select accounts using the checkboxes.'}</span><button className="text-button" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
            <label className="mobile-sort">Sort <select value={query.sort_by} onChange={(event) => sort(event.target.value as SortKey)}><option value="name">Name</option><option value="current_month_minutes">Minutes</option><option value="cost_cents">Cost</option><option value="last_active">Last active</option></select><button className="text-button" aria-label={`Sort ${query.sort_dir === 'asc' ? 'descending' : 'ascending'}`} onClick={() => change({ sort_dir: query.sort_dir === 'asc' ? 'desc' : 'asc', page: 1 })}>{query.sort_dir === 'asc' ? '↑' : '↓'}</button></label></div>
          {accounts.error && <ErrorNotice message={accounts.error} retry={accounts.retry} retained={Boolean(accounts.data)} />}
          {accounts.data ? <Accounts result={accounts.data} query={query} selected={selected} onToggle={toggle}
            onTogglePage={() => setSelected((previous) => togglePageSelection(previous, accounts.data!.data.map((account) => account.id)))} onSort={sort} onEdit={openSettings} />
            : !accounts.error && <div className="accounts-loading"><LoadingAnimation label="Loading accounts…" /></div>}
          <div className="pagination"><span>{accounts.data ? accounts.data.total ? `${number((query.page - 1) * query.page_size + 1)}–${number(Math.min(query.page * query.page_size, accounts.data.total))} of ${number(accounts.data.total)} accounts` : '0 accounts' : 'Loading account count'}</span>
            <label>Rows <select aria-label="Rows per page" value={query.page_size} onChange={(event) => change({ page_size: Number(event.target.value), page: 1 })}>{[10, 25, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
            <div className="page-buttons"><button className="button button-small" disabled={query.page <= 1} onClick={() => change({ page: query.page - 1 })}>Previous</button><span>Page {query.page}{accounts.data && ` of ${number(pageCount)}`}</span><button className="button button-small" disabled={!accounts.data || query.page >= pageCount} onClick={() => change({ page: query.page + 1 })}>Next</button></div></div>
        </section>
        <footer id="data-source"><span><span className="footer-brand">callzo.</span> A clearer view of every conversation.</span><span>Assessment mock data · Refreshes every 15 seconds</span></footer>
      </main>
    </div>
  </div>{editingId && !initialLoading && <SettingsDialog key={editingId} accountId={editingId} close={closeSettings} />}</>;
}
