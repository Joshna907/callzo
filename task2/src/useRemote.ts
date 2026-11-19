import { useCallback, useEffect, useState } from 'react';
import { getJson } from './api';

interface Remote<T> { key: string; data: T | null; error: string | null; busy: boolean; updatedAt: number | null }
export function useRemote<T>(path: string, decode: (value: unknown) => T, merge?: (previous: T, next: T) => T) {
  const [state, setState] = useState<Remote<T>>({ key: path, data: null, error: null, busy: true, updatedAt: null });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) retry(); }, 15000);
    return () => window.clearInterval(timer);
  }, [retry]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((previous) => previous.key === path
      ? { ...previous, busy: true, error: null }
      : { key: path, data: null, error: null, busy: true, updatedAt: null });
    getJson(path, decode, controller.signal).then((data) => {
      if (active) setState((previous) => ({ key: path,
        data: merge && previous.key === path && previous.data ? merge(previous.data, data) : data,
        error: null, busy: false, updatedAt: Date.now() }));
    }).catch((error: unknown) => {
      if (active) setState((previous) => ({ ...previous, busy: false,
        error: error instanceof Error ? error.message : 'Unable to reach the service. Please retry.' }));
    });
    return () => { active = false; controller.abort(); };
  }, [path, decode, revision, merge]);
  return { ...(state.key === path ? state : { data: null, error: null, busy: true, updatedAt: null }), retry };
}
