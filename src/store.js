import { useSyncExternalStore } from 'react';

/**
 * A value that changes often, kept outside React state so updating it only
 * re-renders the components that read it (with useStore), not the whole page
 */
export function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The store's current value, re-rendering the component when it changes
export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get);
}
