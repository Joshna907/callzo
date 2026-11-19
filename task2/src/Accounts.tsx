import { useEffect, useRef } from 'react';
import type { Account, AccountPage } from './api';
import type { Query, SortKey } from './query';
import { money, number } from './UsageChart';

function Check({ checked, mixed = false, label, onChange, disabled = false }: {
  checked: boolean; mixed?: boolean; label: string; onChange: () => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" checked={checked} aria-label={label} disabled={disabled} onChange={onChange} />;
}
export function Accounts({ result, query, selected, onToggle, onTogglePage, onSort, onEdit }: {
  result: AccountPage; query: Query; selected: Set<number>;
  onToggle: (id: number) => void; onTogglePage: () => void; onSort: (key: SortKey) => void;
  onEdit: (id: number) => void;
}) {
  const pageSelected = result.data.filter((account) => selected.has(account.id)).length;
  const pageCheck = <Check checked={result.data.length > 0 && pageSelected === result.data.length}
    mixed={pageSelected > 0 && pageSelected < result.data.length} label="Select all accounts on this page"
    disabled={!result.data.length} onChange={onTogglePage} />;
  const column = (key: SortKey, title: string, numeric = false) => <th className={numeric ? 'numeric' : ''}
    aria-sort={query.sort_by === key ? query.sort_dir === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button onClick={() => onSort(key)}>{title}<span aria-hidden="true" className={query.sort_by === key ? 'sort-active' : 'sort-muted'}>{query.sort_by === key && query.sort_dir === 'asc' ? '↑' : '↓'}</span></button>
  </th>;
  const badge = (account: Account) => <span className={`badge ${account.status}`}><i aria-hidden="true" />{account.status}</span>;
  if (!result.data.length) return <div className="empty-state"><span className="empty-symbol" aria-hidden="true">⌕</span><h3>No matching accounts</h3><p>Try a different search or clear a filter to see more results.</p></div>;
  return <>
    <div className="desktop-table"><table>
      <caption className="sr-only">Account usage. Column headings sort results across all matching accounts.</caption>
      <thead><tr><th className="check-cell">{pageCheck}</th>{column('name', 'Account')}{column('country', 'Country')}
        {column('plan', 'Plan')}{column('status', 'Status')}{column('current_month_minutes', 'Minutes', true)}
        {column('current_month_sms', 'SMS', true)}{column('cost_cents', 'Cost (USD)', true)}{column('last_active', 'Last active')}</tr></thead>
      <tbody>{result.data.map((account) => <tr key={account.id} className={selected.has(account.id) ? 'is-selected' : ''}>
        <td className="check-cell"><Check checked={selected.has(account.id)} label={`Select ${account.name} (${account.email})`} onChange={() => onToggle(account.id)} /></td>
        <td><div className="account-identity"><span className={`avatar tone-${account.id % 4}`} aria-hidden="true">{account.name.split(' ').slice(0, 2).map((word) => word[0]).join('')}</span>
          <div><button className="account-settings-link" aria-label={`Edit settings for ${account.name} (${account.email})`} onClick={() => onEdit(account.id)}>{account.name}</button><span title={`${account.company} · ${account.email}`}>{account.company} · {account.email}</span></div></div></td>
        <td>{account.country}</td><td><span className="plan">{account.plan}</span></td><td>{badge(account)}</td>
        <td className="numeric">{number(account.current_month_minutes)}</td><td className="numeric">{number(account.current_month_sms)}</td>
        <td className="numeric cost">{money(account.cost_cents)}</td><td className="muted nowrap">{account.last_active}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="mobile-accounts"><div className="mobile-select">{pageCheck}<span>Select this page</span></div>
      <ul>{result.data.map((account) => <li key={account.id} className={selected.has(account.id) ? 'is-selected' : ''}>
        <div className="mobile-account-heading"><div><strong>{account.name}</strong><p>{account.company}</p><small>{account.email}</small></div>
          <Check checked={selected.has(account.id)} label={`Select ${account.name} (${account.email})`} onChange={() => onToggle(account.id)} /></div>
        <div className="mobile-badges">{badge(account)}<span className="plan">{account.plan}</span><span className="muted">{account.country}</span></div>
        <dl className="mobile-metrics"><div><dt>Minutes</dt><dd>{number(account.current_month_minutes)}</dd></div><div><dt>SMS</dt><dd>{number(account.current_month_sms)}</dd></div><div><dt>Cost (USD)</dt><dd>{money(account.cost_cents)}</dd></div></dl>
        <p className="last-active">Last active {account.last_active}</p>
        <button className="button button-small mobile-settings-button" aria-label={`Edit settings for ${account.name} (${account.email})`} onClick={() => onEdit(account.id)}>Edit account settings</button>
      </li>)}</ul>
    </div>
  </>;
}
