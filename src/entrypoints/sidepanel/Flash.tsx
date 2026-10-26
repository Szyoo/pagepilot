import { useCallback, useEffect, useRef, useState } from 'react';

export interface FlashMessage {
  id: number;
  text: string;
  tone: 'ok' | 'bad';
}

const FLASH_MS = 4000;

/** 全局提示：约 4 秒后自动消失，卸载时清理定时器 */
export function useFlash() {
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  const flash = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    clearTimeout(timer.current);
    seq.current += 1;
    setMessage({ id: seq.current, text, tone });
    timer.current = setTimeout(() => setMessage(null), FLASH_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { message, flash };
}

export function Flash({ message }: { message: FlashMessage | null }) {
  return (
    <div className="flash-wrap" aria-live="polite">
      {message ? (
        <div key={message.id} className={`flash ${message.tone}`}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
