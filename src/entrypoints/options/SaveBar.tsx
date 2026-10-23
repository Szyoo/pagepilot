import { Button, ErrorText } from '../../shared/ui/components';

export function SaveBar({
  busy,
  error,
  saved,
}: {
  busy: boolean;
  error: string | null;
  saved: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? '保存中…' : '保存'}
      </Button>
      {saved && !error ? (
        <span role="status" className="text-sm text-green-700">
          已保存
        </span>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
