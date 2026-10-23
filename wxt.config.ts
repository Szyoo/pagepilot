import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'PagePilot',
    description: '可配置、云端下发的网页自动化：页面抓取、操作录制与规则回放',
    permissions: ['storage', 'tabs', 'scripting', 'sidePanel', 'alarms'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    side_panel: { default_path: 'sidepanel.html' },
  },
});
