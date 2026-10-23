import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// 端到端测试构建：自动化里无法点击权限弹窗，直接声明本机测试站点的访问权限
const e2e = !!process.env.PAGEPILOT_E2E;
// PAGEPILOT_E2E=trusted：另一份测试构建，把调试权限声明为必选，用于真实输入场景。
// 与普通测试构建分开，其余场景仍验证“没有调试权限时用合成输入”
const e2eTrusted = process.env.PAGEPILOT_E2E === 'trusted';

export default defineConfig({
  srcDir: 'src',
  // 与正常构建分开输出，避免误把带测试权限的产物当成正式版本加载
  ...(e2e ? { outDir: e2eTrusted ? '.output/e2e-trusted' : '.output/e2e' } : {}),
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'PagePilot',
    description: '可配置、云端下发的网页自动化：页面抓取、操作录制与规则回放',
    permissions: [
      'storage',
      'tabs',
      'scripting',
      'sidePanel',
      'alarms',
      'webNavigation',
      'notifications',
      'offscreen',
      // @types/chrome 的权限列表尚未收录 debugger
      ...(e2eTrusted ? (['debugger'] as unknown as 'tabs'[]) : []),
    ],
    // 真实输入需要调试权限，运行期间浏览器会显示调试提示条，所以只在用户需要时申请
    // @types/chrome 的可选权限列表尚未收录 debugger
    optional_permissions: ['debugger'] as unknown as 'tabs'[],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(e2e ? { host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'] } : {}),
    side_panel: { default_path: 'sidepanel.html' },
  },
});
