import { useState } from 'react';

/**
 * Run `onDone` once each time a form action hands back a NEW result that `isDone` accepts.
 * (React's recommended way to react to a changed value without an effect: the component's own state
 * is adjusted while rendering, so there is no extra render pass and no stale frame.)
 */
export function useWhenDone<S extends object>(
  result: S,
  isDone: (s: S) => boolean,
  onDone: () => void,
) {
  const [seen, setSeen] = useState(result);
  if (result !== seen) {
    setSeen(result);
    if (isDone(result)) onDone();
  }
}
