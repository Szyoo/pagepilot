import { browser } from 'wxt/browser';
import type { StatusTone } from './lib';

function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function TopBar({
  tone,
  text,
  adminHref,
  onOpenAdmin,
}: {
  tone: StatusTone;
  text: string;
  /** 管理页地址；null 表示没有配置后台地址 */
  adminHref: string | null;
  onOpenAdmin: () => void;
}) {
  const version = browser.runtime.getManifest().version;
  return (
    <header className="topbar">
      <div className="status" role="status">
        <span className={`dot ${tone === 'gray' ? '' : tone}`} aria-hidden="true" />
        <span className="ellipsis">{text}</span>
      </div>
      <div className="top-actions">
        <span className="version">v{version}</span>
        <button
          type="button"
          className="btn sm pill inline"
          onClick={onOpenAdmin}
          disabled={adminHref === null}
          title={adminHref === null ? '先在设置页填写后台地址' : '在新标签页打开后台管理页'}
          aria-label="打开后台管理页"
        >
          管理页
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void browser.runtime.openOptionsPage()}
          title="设置"
          aria-label="打开设置页"
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
