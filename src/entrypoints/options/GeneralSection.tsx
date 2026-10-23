import { type FormEvent, useState } from 'react';
import { type Settings, saveSettings } from '../../shared/settings';
import { Field, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { SaveBar } from './SaveBar';
import { Section } from './Section';

export function GeneralSection({ settings }: { settings: Settings }) {
  const [sound, setSound] = useState(settings.sound);
  const [minRepeat, setMinRepeat] = useState(String(settings.minRepeatIntervalMs));
  const [saved, setSaved] = useState(false);
  const save = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      await saveSettings({
        sound,
        minRepeatIntervalMs: Number(minRepeat),
      });
      return true;
    });
    if (ok) setSaved(true);
  };

  return (
    <Section title="通用">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              className="size-4"
              checked={sound}
              onChange={(e) => setSound(e.target.checked)}
            />
            启用提示音
          </label>
          <p className="text-xs text-slate-500">
            开启后，规则中设置了 sound 的循环在条件满足时才会播放提示音。默认关闭。
          </p>
        </div>
        <Field
          label="最小刷新间隔（毫秒）"
          hint="循环两轮之间的最小间隔，规则无法低于该值，至少 1000"
        >
          {(id) => (
            <input
              id={id}
              type="number"
              min={1000}
              step={100}
              className={inputClass}
              value={minRepeat}
              onChange={(e) => setMinRepeat(e.target.value)}
              required
            />
          )}
        </Field>
        <SaveBar busy={save.busy} error={save.error} saved={saved} />
      </form>
    </Section>
  );
}
