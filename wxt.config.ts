import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';
import { originPatternOf } from './src/shared/glob';

// 端到端测试构建：自动化里无法点击权限弹窗，直接声明本机测试站点的访问权限
const e2e = !!process.env.PAGEPILOT_E2E;
// PAGEPILOT_E2E=trusted：另一份测试构建，把调试权限声明为必选，用于真实输入场景。
// 与普通测试构建分开，其余场景仍验证“没有调试权限时用合成输入”
const e2eTrusted = process.env.PAGEPILOT_E2E === 'trusted';

// 构建期默认的后台、门户与 AI 服务（claude-bridge）地址来自本机 .env（不进仓库）。已知地址时直接声明它们的访问权限，
// 登录时就不再弹权限申请；没有配置时仍按需向用户申请。
const env = loadEnv('production', process.cwd(), 'VITE_');
const knownOrigins = [
  env.VITE_DEFAULT_BACKEND_URL,
  env.VITE_DEFAULT_PORTAL_URL,
  env.VITE_DEFAULT_BRIDGE_URL,
]
  .filter((u): u is string => Boolean(u))
  .map((u) => originPatternOf(`${u.replace(/\/+$/, '')}/`))
  .filter((o): o is string => o !== null);

export default defineConfig({
  srcDir: 'src',
  // 与正常构建分开输出，避免误把带测试权限的产物当成正式版本加载
  ...(e2e ? { outDir: e2eTrusted ? '.output/e2e-trusted' : '.output/e2e' } : {}),
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    // 测试构建不使用本机 .env 里的真实地址
    ...(e2e
      ? {
          define: {
            'import.meta.env.VITE_DEFAULT_BACKEND_URL': '""',
            'import.meta.env.VITE_DEFAULT_PORTAL_URL': '""',
            'import.meta.env.VITE_DEFAULT_BRIDGE_URL': '""',
          },
        }
      : {}),
  }),
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
    // <all_urls>：「请 AI 看看」附截图时才申请（tabs.captureVisibleTab 只认 <all_urls> 或 activeTab）
    optional_host_permissions: ['https://*/*', 'http://*/*', '<all_urls>'],
    ...(e2e
      ? // <all_urls> 供截图用（自动化里无法点权限弹窗）；内容脚本只按 http(s) 的具体站点注册，不受它影响
        { host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', '<all_urls>'] }
      : knownOrigins.length > 0
        ? { host_permissions: [...new Set(knownOrigins)] }
        : {}),
    // 没有弹窗：点扩展图标直接打开侧边栏（后台启动时设置 openPanelOnActionClick）
    action: { default_title: 'PagePilot' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
