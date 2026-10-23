import { ErrorText } from '../../shared/ui/components';
import { useBgState } from '../../shared/ui/useBgState';
import { ConnectionSection } from './ConnectionSection';
import { GeneralSection } from './GeneralSection';
import { SitesSection } from './SitesSection';
import { useSettings } from './useSettings';
import { VaultSection } from './VaultSection';

export function App() {
  const { state, error: bgError } = useBgState();
  const { settings, error: settingsError } = useSettings();

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="text-xl font-bold">PagePilot 设置</h1>
        <ErrorText>{bgError ?? settingsError}</ErrorText>
        {settings ? (
          <ConnectionSection settings={settings} bg={state} />
        ) : (
          <p role="status" className="text-sm text-slate-500">
            加载中…
          </p>
        )}
        <VaultSection signedIn={state ? state.auth.status === 'signedIn' : undefined} />
        {settings ? <SitesSection settings={settings} /> : null}
        {settings ? <GeneralSection settings={settings} /> : null}
      </div>
    </main>
  );
}
