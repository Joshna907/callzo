import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Account } from './api';
import { loadSettings, readBrowserBackup, settingsTransport } from './settings-api';
import { SettingsEditor, steps, validateStep, type EditorSnapshot, type Field, type Step } from './settings-model';
import { LoadingAnimation } from './LoadingAnimation';
import './settings.css';

const titles: Record<Step, string> = { 1: 'Account details', 2: 'Plan & billing', 3: 'Usage limits', 4: 'Integration & review' };

function Editor({ editor, account, close }: { editor: SettingsEditor; account: Account; close: () => void }) {
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [step, setStep] = useState<Step>(1);
  const [notice, setNotice] = useState('');
  const [backupUnavailable, setBackupUnavailable] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const fields = useRef<HTMLFormElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step, snapshot.finalized]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (editor.hasPendingEdits()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [editor]);
  useEffect(() => {
    try {
      if (snapshot.finalized) sessionStorage.removeItem(`callzo-settings-${account.id}`);
      else sessionStorage.setItem(`callzo-settings-${account.id}`, JSON.stringify(editor.backup()));
    } catch { setBackupUnavailable(true); }
  }, [snapshot, editor, account.id]);
  useEffect(() => {
    if (snapshot.finalized || snapshot.submitting || snapshot.saving || !editor.isDirty(step) ||
        snapshot.messages[step] || snapshot.recovery[step] || Object.keys(validateStep(step, snapshot.draft)).length ||
        (step === 4 && !snapshot.confirmed[2])) return;
    const timer = window.setTimeout(() => { void editor.save(step); }, 650);
    return () => window.clearTimeout(timer);
  }, [editor, step, snapshot]);

  const navigate = (next: Step) => {
    if (snapshot.submitting) return;
    if (editor.isDirty(step) && !snapshot.recovery[step]) void editor.save(step);
    setNotice(''); setStep(next);
  };
  const focusError = () => fields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  const advance = async () => {
    setNotice('');
    if (snapshot.recovery[step]) { setNotice('Restore your attempted edits and retry, or use the last confirmed values before continuing.'); return; }
    if (step < 4) {
      if (await editor.save(step)) setStep((step + 1) as Step);
      else window.requestAnimationFrame(focusError);
    } else {
      const failedStep = await editor.finish();
      if (failedStep) { setStep(failedStep); window.requestAnimationFrame(focusError); }
    }
  };
  const field = (name: Field, label: string, help?: string, type = 'text') => {
    const error = snapshot.errors[step]?.[name];
    const id = `settings-${account.id}-${name}`;
    return <div className="setting-field"><label htmlFor={id}>{label}</label>
      <input id={id} name={name} type={type} value={snapshot.draft[name]} disabled={snapshot.submitting}
        inputMode={name.endsWith('_cap') ? 'decimal' : undefined}
        autoComplete={name === 'email' ? 'email' : name === 'name' ? 'name' : 'off'}
        maxLength={name === 'webhook_url' ? 2048 : name.endsWith('_cap') ? 24 : 254}
        aria-invalid={Boolean(error)} aria-describedby={[help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined}
        onChange={(event) => editor.edit(name, event.target.value)} />
      {help && <small id={`${id}-help`}>{help}</small>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}
    </div>;
  };
  const select = (name: Field, label: string, options: [string, string][]) => {
    const id = `settings-${account.id}-${name}`; const error = snapshot.errors[step]?.[name];
    return <div className="setting-field"><label htmlFor={id}>{label}</label><select id={id} name={name}
      value={snapshot.draft[name]} disabled={snapshot.submitting} aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => editor.edit(name, event.target.value)}>
      <option value="">Choose an option</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>;
  };
  const errorSteps = steps.filter((value) => snapshot.messages[value] || Object.keys(snapshot.errors[value] ?? {}).length);
  const saveLabel = snapshot.saving ? `Saving step ${snapshot.saving}…`
    : errorSteps.length ? 'Some changes need attention'
    : steps.some((value) => editor.isDirty(value)) ? 'Draft in progress · changes autosave' : 'All four steps saved';

  if (snapshot.finalized) return <div className="settings-success"><span aria-hidden="true">✓</span>
    <h2 ref={heading} tabIndex={-1}>Account settings submitted</h2><p>The service confirmed all four steps for {snapshot.draft.name}.</p>
    <button className="button button-primary" onClick={close}>Back to accounts</button></div>;
  return <>
    <nav className="settings-steps" aria-label="Settings steps"><ol>{steps.map((value) => <li key={value}>
      <button type="button" aria-current={step === value ? 'step' : undefined} disabled={snapshot.submitting}
        className={`${step === value ? 'current' : ''} ${errorSteps.includes(value) ? 'has-error' : ''}`}
        onClick={() => navigate(value)}><span className="step-number">{errorSteps.includes(value) ? '!' : value}</span>
        <span>{titles[value]}<small>{errorSteps.includes(value) ? 'Needs attention' : snapshot.confirmed[value] && !editor.isDirty(value) ? 'Saved' : 'Draft'}</small></span></button>
    </li>)}</ol></nav>
    <div className="settings-status" role="status">{saveLabel}</div>
    {errorSteps.some((value) => value !== step) && <div className="settings-cross-error" role="status">
      {errorSteps.filter((value) => value !== step).map((value) => <button className="text-button" key={value} onClick={() => setStep(value)}>Review step {value}: {titles[value]}</button>)}
    </div>}
    <form ref={fields} className="settings-form" noValidate onSubmit={(event) => { event.preventDefault(); void advance(); }}>
      <div className="settings-step-heading"><p className="eyebrow">STEP {step} OF 4</p><h3 ref={heading} tabIndex={-1}>{titles[step]}</h3>
        <p>{step === 1 ? 'Keep account contact information up to date.' : step === 2 ? 'Choose the plan and supported billing country.' : step === 3 ? 'Optional limits. Leave a field blank for no configured limit.' : 'Configure an optional webhook and review before submitting.'}</p></div>
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      {snapshot.messages[step] && <div className="settings-error" role="alert"><p>{snapshot.messages[step]}</p>
        {snapshot.recovery[step] && <button type="button" className="text-button" onClick={() => { void editor.restoreAttempt(step); }}>Restore attempted edits and retry</button>}
        <button type="button" className="text-button" onClick={() => editor.restoreConfirmed(step)}>{snapshot.confirmed[step] ? 'Use last confirmed values' : 'Use account defaults'}</button>
      </div>}
      {step === 1 && <div className="settings-fields">{field('name', 'Account name')}{field('email', 'Contact email', 'Used for account correspondence.', 'email')}</div>}
      {step === 2 && <>
        <div className="settings-fields">{select('plan', 'Plan', [['basic', 'Basic'], ['pro', 'Pro'], ['enterprise', 'Enterprise']])}
          {select('billing_country', 'Billing country', [['US', 'United States'], ['IN', 'India'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia']])}</div>
        {snapshot.confirmed[4] && <div className="settings-notice"><strong>Billing changes after integration</strong>
          <p>The billing service may reject changes after integration is saved. If this happens, restore your saved billing details to continue. Other saved steps remain intact.</p>
          {snapshot.errors[2]?.billing_country && snapshot.confirmed[2] && <button className="text-button" type="button" onClick={() => {
            editor.restoreConfirmed(2); setNotice('Previous billing details restored. Continue to Integration & review to finish without re-saving billing.');
          }}>Restore saved billing details and continue</button>}
        </div>}
      </>}
      {step === 3 && <div className="settings-fields">{field('minutes_cap', 'Monthly minutes cap', 'Number of minutes; blank leaves this limit unset.')}{field('sms_cap', 'Monthly SMS cap', 'Number of messages; blank leaves this limit unset.')}</div>}
      {step === 4 && <>
        {field('webhook_url', 'Webhook URL', 'Optional. Use a complete http:// or https:// address.', 'url')}
        {!snapshot.confirmed[2] && <p className="settings-notice">Save billing details in step 2 before this step can autosave.</p>}
        <Review snapshot={snapshot} />
      </>}
      {backupUnavailable && <p className="settings-notice">Browser recovery storage is unavailable. Wait for saved confirmation before refreshing.</p>}
      <div className="settings-actions"><button type="button" className="button" disabled={step === 1 || snapshot.submitting} onClick={() => navigate((step - 1) as Step)}>Back</button>
        <button type="button" className="text-button" disabled={snapshot.submitting || snapshot.saving !== null} onClick={() => { void editor.save(step); }}>Save this step</button>
        <button type="submit" className="button button-primary" disabled={snapshot.submitting}>{snapshot.submitting ? 'Submitting…' : step === 4 ? 'Finish setup' : 'Save & continue'}</button>
      </div>
      <p className="settings-footnote">Valid edits autosave after a short pause. Closing keeps saved drafts; pending edits stay in this browser session.</p>
    </form>
  </>;
}

function Review({ snapshot }: { snapshot: EditorSnapshot }) {
  const draft = snapshot.draft;
  return <section className="settings-review" aria-label="Review account settings"><h4>Review your settings</h4><dl>
    {[['Account', draft.name], ['Email', draft.email], ['Plan', draft.plan], ['Billing country', draft.billing_country],
      ['Minutes cap', draft.minutes_cap || 'Not configured'], ['SMS cap', draft.sms_cap || 'Not configured']].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || 'Not provided'}</dd></div>)}
  </dl></section>;
}

export function SettingsDialog({ accountId, close }: { accountId: number; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<{ editor: SettingsEditor; account: Account } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setError(''); setLoaded(null);
    loadSettings(accountId, controller.signal).then(({ account, saved }) => {
      if (active) setLoaded({ account, editor: new SettingsEditor(account, saved, settingsTransport(accountId), readBrowserBackup(accountId)) });
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not restore this account draft.');
    });
    return () => { active = false; controller.abort(); };
  }, [accountId, revision]);
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={(event) => {
    event.preventDefault(); if (!loaded?.editor.getSnapshot().submitting) close();
  }}>
    <header className="settings-header"><div><p className="eyebrow">ACCOUNT SETTINGS · #{accountId}</p><h2 id="settings-title">{loaded?.account.name ?? 'Account settings'}</h2></div>
      <button type="button" className="settings-close" aria-label="Close account settings" onClick={() => { if (!loaded?.editor.getSnapshot().submitting) close(); }}>×</button></header>
    {error ? <div className="settings-load-error" role="alert"><h3>Couldn’t restore this draft</h3><p>{error}</p><button className="button" onClick={() => setRevision((value) => value + 1)}>Retry loading draft</button></div>
      : loaded ? <Editor editor={loaded.editor} account={loaded.account} close={close} /> : <LoadingAnimation label="Restoring saved account settings…" />}
  </dialog>;
}
