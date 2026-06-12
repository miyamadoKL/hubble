import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value (design.md §5: 検索 デバウンス 300ms). The
 * returned value trails `value` by `delayMs`; the timer resets on every change,
 * so it only settles once the input goes quiet. Used by the Saved-queries
 * search so each keystroke doesn't fire a request.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
