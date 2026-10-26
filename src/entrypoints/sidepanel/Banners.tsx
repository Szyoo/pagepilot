import { browser } from 'wxt/browser';
import { type BgState, rpc } from '../../shared/rpc';
import { useAction } from '../../shared/ui/useAction';
import { Btn, ErrorLine } from './parts';

/** 页头下方的全局提示：未登录优先，连接出错次之，二者互斥 */
export function Banners({ state }: { state: BgState }) {
  const retry = useAction();
  const openSettings = () => void browser.runtime.openOptionsPage();

  if (state.auth.status !== 'signedIn') {
    return (
      <div className="banners">
        <div className="banner" role="status">
          <p className="banner-title">还没有登录门户账号</p>
          <Btn kind="primary" size="sm" onClick={openSettings}>
            去设置页登录
          </Btn>
        </div>
      </div>
    );
  }
  if (state.connection.status === 'error') {
    return (
      <div className="banners">
        <div className="banner" role="alert">
          <p className="banner-title">连接出错</p>
          <p className="break">{state.connection.error ?? '无法连接到后台'}</p>
          <div className="btn-row">
            <Btn
              kind="primary"
              size="sm"
              disabled={retry.busy}
              onClick={() => void retry.run(() => rpc('connection.retry'))}
            >
              {retry.busy ? '重试中…' : '重试'}
            </Btn>
            <Btn size="sm" onClick={openSettings}>
              去设置页
            </Btn>
          </div>
          <ErrorLine>{retry.error}</ErrorLine>
        </div>
      </div>
    );
  }
  return null;
}
