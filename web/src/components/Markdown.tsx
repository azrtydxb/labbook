import { History, Pencil } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fmtDateTime } from '../lib/format';
import type { Edit } from '../lib/types';
import { Button, ErrorNote, Textarea, cx } from './ui';

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('prose-lab text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/** Rendered markdown with in-place editing and the field's edit history. */
export function MarkdownField({
  label,
  value,
  onSave,
  edits = [],
  placeholder,
}: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  edits?: Edit[];
  placeholder: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);

  const start = () => {
    setDraft(value);
    setTab('write');
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{label}</h3>
        <div className="flex gap-1">
          {edits.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
            >
              <History className="size-3.5" aria-hidden /> {edits.length} edit{edits.length === 1 ? '' : 's'}
            </Button>
          )}
          {!editing && (
            <Button size="sm" variant="ghost" onClick={start}>
              <Pencil className="size-3.5" aria-hidden /> Edit
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <div className="flex gap-1 text-xs" role="tablist">
            {(['write', 'preview'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cx(
                  'rounded px-2 py-1 capitalize',
                  tab === t ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:text-ink',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === 'write' ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(24, Math.max(6, draft.split('\n').length + 2))}
              placeholder={placeholder}
              aria-label={label}
              autoFocus
            />
          ) : (
            <div className="min-h-24 rounded-md border border-rule p-3">
              {draft.trim() ? (
                <Markdown text={draft} />
              ) : (
                <p className="text-sm text-ink-3">Nothing to preview.</p>
              )}
            </div>
          )}
          <ErrorNote error={error} />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={save} loading={saving}>
              Save {label.toLowerCase()}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="self-center text-xs text-ink-3">Markdown supported</span>
          </div>
        </div>
      ) : value.trim() ? (
        <Markdown text={value} />
      ) : (
        <button onClick={start} className="text-left text-sm text-ink-3 hover:text-ink-2">
          {placeholder}
        </button>
      )}
      {showHistory && (
        <ol className="mt-3 space-y-2 border-l-2 border-rule pl-3">
          {edits.map((e) => (
            <li key={e.id} className="text-xs">
              <div className="text-ink-3">
                {fmtDateTime(e.editedAt)} by {e.editedBy ?? 'unknown'}
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-ink-2">Previous text</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-panel-2 p-2 font-mono text-[12px] text-ink-2">
                  {e.oldValue || '(empty)'}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
