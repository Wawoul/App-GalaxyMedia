import { useCallback, useRef, useState } from 'react';

interface State<T> { past: T[]; present: T; future: T[] }
const LIMIT = 100;
const COALESCE_MS = 700;

/**
 * Undo/redo over immutable snapshots. Rapid edits sharing a `key` (dragging a slider,
 * typing in a field, nudging with arrow keys) collapse into one undo step instead of
 * flooding the stack.
 */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState<State<T>>({ past: [], present: initial, future: [] });
  const last = useRef<{ key: string; at: number } | null>(null);

  const set = useCallback((next: T, key?: string) => {
    const now = Date.now();
    const merge = !!key && last.current?.key === key && now - last.current.at < COALESCE_MS;
    last.current = key ? { key, at: now } : null;
    setState((s) => ({
      past: merge ? s.past : [...s.past.slice(-(LIMIT - 1)), s.present],
      present: next,
      future: [],
    }));
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setState((s) => (s.past.length === 0 ? s : {
      past: s.past.slice(0, -1), present: s.past[s.past.length - 1]!, future: [s.present, ...s.future],
    }));
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setState((s) => (s.future.length === 0 ? s : {
      past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1),
    }));
  }, []);

  /** Replace the document without recording history (initial load, template swap handled by set). */
  const reset = useCallback((value: T) => {
    last.current = null;
    setState({ past: [], present: value, future: [] });
  }, []);

  return {
    doc: state.present, set, undo, redo, reset,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
  };
}
