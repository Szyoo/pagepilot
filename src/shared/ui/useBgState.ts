import { useCallback, useEffect, useState } from 'react';
import { type BgState, onStateChanged, rpc } from '../rpc';

export interface BgStateResult {
  state: BgState | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 挂载时拉取后台状态，并在后台状态变化时重新拉取 */
export function useBgState(): BgStateResult {
  const [state, setState] = useState<BgState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await rpc('state.get'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onStateChanged(() => void refresh());
  }, [refresh]);

  return { state, error, refresh };
}
