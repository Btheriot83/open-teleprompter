import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { importFile } from '../lib/import';
import {
  type Script,
  loadAll,
  setActiveId,
  newId,
  removeScript,
  upsertScript,
} from '../lib/storage';
import { durationFromWpm, getModeWpm, type Settings, nextMirror } from '../lib/settings';

type Props = {
  script: Script;
  onChange: (s: Script) => void;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onStartPrompter: () => void;
};

type Toast = {
  kind: 'undo-delete';
  script: Script;
  expires: number;
};

export default function Editor({ script, onChange, settings, onSettings, onStartPrompter }: Props) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<Script[]>(() => loadAll());
  const [isDirty, setIsDirty] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const refreshList = useCallback(() => {
    setList(loadAll());
  }, []);

  useEffect(() => {
    refreshList();
  }, [script.id, refreshList]);

  // Mirror the App-level debounce so we can show an "autosave in flight" indicator.
  // Resets ~300ms after the last edit, just past App's 250ms write debounce.
  useEffect(() => {
    setIsDirty(true);
    const t = setTimeout(() => {
      setIsDirty(false);
      // The App debounce just persisted — pick up changes so the active row in
      // the list reflects the latest title/text snippet.
      refreshList();
    }, 320);
    return () => clearTimeout(t);
  }, [script.text, script.title, refreshList]);

  // Auto-dismiss the undo toast.
  useEffect(() => {
    if (!toast) return;
    const remaining = toast.expires - Date.now();
    if (remaining <= 0) {
      setToast(null);
      return;
    }
    const t = setTimeout(() => setToast(null), remaining);
    return () => clearTimeout(t);
  }, [toast]);

  function update(patch: Partial<Script>) {
    onChange({ ...script, ...patch, updatedAt: Date.now() });
  }

  async function handleFile(file: File) {
    setImporting(true);
    setImportError(null);
    try {
      const text = await importFile(file);
      const baseTitle = file.name.replace(/\.[^.]+$/, '');
      update({ text, title: script.title || baseTitle });
    } catch (e: any) {
      setImportError(e?.message ?? 'Import failed');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function newScript() {
    const s: Script = {
      id: newId(),
      title: 'Untitled',
      text: '',
      updatedAt: Date.now(),
    };
    upsertScript(s);
    setActiveId(s.id);
    onChange(s);
    refreshList();
  }

  function loadScript(id: string) {
    const fresh = loadAll();
    const s = fresh.find((x) => x.id === id);
    if (!s) return;
    setActiveId(s.id);
    onChange(s);
    setList(fresh);
  }

  function deleteScript(target: Script) {
    const remaining = removeScript(target.id);
    setList(remaining);
    setToast({
      kind: 'undo-delete',
      script: target,
      expires: Date.now() + 6000,
    });
    if (script.id === target.id) {
      if (remaining.length) {
        setActiveId(remaining[0].id);
        onChange(remaining[0]);
      } else {
        // No scripts left — spin up a fresh blank one.
        const s: Script = {
          id: newId(),
          title: 'Untitled',
          text: '',
          updatedAt: Date.now(),
        };
        upsertScript(s);
        setActiveId(s.id);
        onChange(s);
        setList(loadAll());
      }
    }
  }

  function undoDelete() {
    if (!toast || toast.kind !== 'undo-delete') return;
    upsertScript(toast.script);
    setToast(null);
    refreshList();
  }

  function exportTxt() {
    const blob = new Blob([script.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (script.title || 'script') + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  const wordCount = (script.text.trim().match(/\S+/g) || []).length;

  // Live broadcast-strip metrics (uses the same words-per-px heuristic as Prompter)
  const stripStats = useMemo(() => {
    const totalSec =
      settings.mode === 'timed'
        ? settings.durationSec
        : wordCount / Math.max(0.1, settings.speed / 80);
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const wpm = getModeWpm(settings, wordCount);
    return {
      duration: `${m}:${s.toString().padStart(2, '0')}`,
      wpm,
    };
  }, [settings.durationSec, settings.mode, settings.speed, wordCount]);
  const savedAt = useMemo(() => {
    return new Date(script.updatedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [script.updatedAt]);
  const idShort = useMemo(() => script.id.slice(0, 6), [script.id]);
  const hasContent = script.text.trim().length > 0;

  return (
    <div className="broadcast-desk-shell fade-up">
      <header className="broadcast-hud">
        <div className="studio-brand">
          <Logo />
          <div>
            <div className="studio-eyebrow">Open prompt / v1</div>
            <h1>Studio desk</h1>
            <p>Script-first broadcast control.</p>
          </div>
        </div>
        <div className="hud-metrics" aria-label="Script telemetry">
          <HudMetric label="state" value="Standby" hot />
          <HudMetric label="runtime" value={stripStats.duration} />
          <HudMetric label="words" value={wordCount.toString()} />
          <HudMetric label="wpm" value={stripStats.wpm.toString()} />
        </div>
        <div className="studio-actions">
          <button
            type="button"
            onClick={newScript}
            className="btn-ghost studio-action"
          >
            + New
          </button>
          <button
            type="button"
            onClick={onStartPrompter}
            disabled={!hasContent}
            className="btn-tally studio-live"
            title={hasContent ? 'Enter prompter (Go Live)' : 'Add a script first'}
          >
            <span
              className="live-dot pulse-dot"
              style={{ boxShadow: '0 0 8px rgba(255,255,255,0.7)' }}
            />
            Go Live
          </button>
        </div>
      </header>

      <div className="strip studio-strip secondary-strip">
        <span className="strip-cell">
          <span className="strip-key">deck</span>
          <span className="text-white/85 tabular-nums">{list.length}</span>
        </span>
        <span className="strip-cell">
          <span className="strip-key">est</span>
          <span className="text-white/85 tabular-nums">{stripStats.duration}</span>
          <span className="text-white/30">@</span>
          <span className="text-white/55 tabular-nums">60px/s</span>
        </span>
        <span className="strip-cell">
          <span className="strip-key">wpm</span>
          <span className="text-white/85 tabular-nums">{stripStats.wpm}</span>
        </span>
        <span className="strip-cell ml-auto">
          {isDirty ? (
            <>
              <span
                className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] pulse-dot"
                style={{ boxShadow: '0 0 6px rgba(255,45,45,0.7)' }}
              />
              <span className="text-[#ff8a8a]">autosave…</span>
            </>
          ) : (
            <>
              <span className="strip-key">saved</span>
              <span className="text-white/65 tabular-nums">{savedAt}</span>
            </>
          )}
        </span>
        <span className="strip-cell">
          <span className="strip-key">id</span>
          <span className="text-white/45 tabular-nums">{idShort}</span>
        </span>
      </div>

      {importError && (
        <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {importError}
        </div>
      )}

      <main className="studio-grid">
        <section className="manuscript-wrap">
          <div className="manuscript-toolbar">
            <div>
              <div className="micro-label">
                Active script
              </div>
              <input
                type="text"
                value={script.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="Untitled"
                className="title-field"
              />
            </div>
            <div className="manuscript-meta">
              <span>{wordCount} words</span>
              <span>/</span>
              <span>{stripStats.duration}</span>
            </div>
          </div>

          <div className="file-rail">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="btn-ghost studio-file"
            >
              {importing ? (
                <span className="inline-flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] pulse-dot" />
                  Importing…
                </span>
              ) : (
                <>↥ Import .txt / .pdf / .docx</>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={exportTxt}
              disabled={!script.text}
              className="btn-ghost studio-file"
            >
              ↧ Export .txt
            </button>
            <span>{wordCount} words</span>
          </div>

          <div className="paper-stage">
            <textarea
              value={script.text}
              onChange={(e) => update({ text: e.target.value })}
              placeholder=""
              spellCheck={false}
              className="script-stage"
            />
            <div className="stage-cue" aria-hidden="true">
              <span />
            </div>
            {!hasContent && (
              <div className="empty-paper">
                <div className="micro-label">
                  // No script loaded
                </div>
                <div>
                  Paste or type a script, or pull one in from file.
                </div>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="btn-ghost studio-file"
                >
                  ↥ Import .txt / .pdf / .docx
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="show-queue-stack">
          <PromptSettingsPanel
            wordCount={wordCount}
            duration={stripStats.duration}
            wpm={stripStats.wpm}
            savedAt={savedAt}
            isDirty={isDirty}
            settings={settings}
            onSettings={onSettings}
          />

          <SavedScriptsPanel
            list={list}
            activeId={script.id}
            onLoad={loadScript}
            onDelete={deleteScript}
            onNew={newScript}
          />
        </aside>
      </main>

      <footer className="command-rail">
        <span className="kbd">space</span> play · <span className="kbd">↑↓</span> speed · <span className="kbd">←→</span> size · <span className="kbd">R</span> restart · <span className="kbd">M</span> mirror · <span className="kbd">esc</span> exit
      </footer>

      {toast && toast.kind === 'undo-delete' && (
        <UndoToast
          label={
            <>
              Deleted{' '}
              <span className="text-white/80">
                "{toast.script.title || 'Untitled'}"
              </span>
            </>
          }
          onUndo={undoDelete}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

function HudMetric({ label, value, hot = false }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className={`hud-metric ${hot ? 'is-hot' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PromptSettingsPanel({
  wordCount,
  duration,
  wpm,
  savedAt,
  isDirty,
  settings,
  onSettings,
}: {
  wordCount: number;
  duration: string;
  wpm: number;
  savedAt: string;
  isDirty: boolean;
  settings: Settings;
  onSettings: (s: Settings) => void;
}) {
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    onSettings({ ...settings, [key]: value });
  }

  const modeLabel =
    settings.mode === 'fixed' ? 'standby' : settings.mode === 'timed' ? 'timed' : 'voice';
  const modeWpm = getModeWpm(settings, wordCount);

  return (
    <section className="control-panel slate-panel" aria-labelledby="prompt-settings-h">
      <header className="panel-heading">
        <div>
          <h2 id="prompt-settings-h">Control slate</h2>
          <p>Prompt telemetry</p>
        </div>
        <span className="status-pill">{modeLabel}</span>
      </header>

      <div className="readiness-grid">
        <Metric label="Words" value={wordCount.toString()} />
        <Metric label={settings.mode === 'timed' ? 'Target' : 'Est'} value={duration} />
        <Metric label="WPM" value={wpm.toString()} />
        <Metric label="Saved" value={isDirty ? 'syncing' : savedAt} hot={isDirty} />
      </div>

      <div className="slate-mode-row" aria-label="Slate mode">
        {(['fixed', 'timed', 'voice'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => set('mode', mode)}
            className={`slate-mode-button ${settings.mode === mode ? 'active' : ''}`}
          >
            {mode}
          </button>
        ))}
      </div>

      {settings.mode === 'timed' && (
        <p className="slate-mode-note">
          Set a target finish time. Timed mode recalculates the reading pace so all{' '}
          {wordCount || 0} words fit that window.
        </p>
      )}

      {settings.mode === 'timed' ? (
        <ControlSlider
          label="Reading pace"
          value={`${modeWpm} wpm`}
          min={20}
          max={240}
          step={5}
          numericValue={modeWpm}
          onChange={(value) => set('durationSec', durationFromWpm(wordCount, value))}
        />
      ) : (
        <ControlSlider
          label="Speed"
          value={`${settings.speed} px/s`}
          min={10}
          max={400}
          step={5}
          numericValue={settings.speed}
          onChange={(value) => set('speed', value)}
        />
      )}

      {settings.mode === 'timed' && (
        <ControlSlider
          label="Target time"
          value={`${Math.floor(settings.durationSec / 60)}:${(settings.durationSec % 60)
            .toString()
            .padStart(2, '0')}`}
          min={15}
          max={1800}
          step={15}
          numericValue={settings.durationSec}
          onChange={(value) => set('durationSec', value)}
        />
      )}
      <ControlSlider
        label="Text size"
        value={`${settings.fontSize} px`}
        min={16}
        max={160}
        step={2}
        numericValue={settings.fontSize}
        onChange={(value) => set('fontSize', value)}
      />

      <div className="toggle-grid" aria-label="Visual prompt controls">
        <button
          type="button"
          onClick={() => set('mirror', nextMirror(settings.mirror))}
          className={`toggle-chip ${settings.mirror !== 'none' ? 'active' : ''}`}
          title={`Mirror: ${settings.mirror}`}
        >
          <span />Mirror
        </button>
        <button
          type="button"
          onClick={() => set('mode', settings.mode === 'voice' ? 'fixed' : 'voice')}
          className={`toggle-chip ${settings.mode === 'voice' ? 'active' : ''}`}
        >
          <span />Voice
        </button>
        <button
          type="button"
          onClick={() => set('cameraMirror', !settings.cameraMirror)}
          className={`toggle-chip ${settings.cameraMirror ? 'active' : ''}`}
        >
          <span />Camera
        </button>
        <button
          type="button"
          onClick={() =>
            set(
              'readingGuide',
              settings.readingGuide === 'chevron'
                ? 'line'
                : settings.readingGuide === 'line'
                  ? 'none'
                  : 'chevron'
            )
          }
          className={`toggle-chip ${settings.readingGuide !== 'none' ? 'active' : ''}`}
          title={`Cue: ${settings.readingGuide}`}
        >
          <span />Cue
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value, hot = false }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong className={hot ? 'text-[#ff8a8a]' : undefined}>{value}</strong>
    </div>
  );
}

function ControlSlider({
  label,
  value,
  min,
  max,
  step,
  numericValue,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  numericValue: number;
  onChange: (value: number) => void;
}) {
  const fill = `${((numericValue - min) / (max - min)) * 100}%`;
  return (
    <div className="control-meter">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="meter-track">
        <span style={{ width: fill }} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={numericValue}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="slate-range"
      />
    </div>
  );
}

function SavedScriptsPanel({
  list,
  activeId,
  onLoad,
  onDelete,
  onNew,
}: {
  list: Script[];
  activeId: string;
  onLoad: (id: string) => void;
  onDelete: (s: Script) => void;
  onNew: () => void;
}) {
  return (
    <section
      aria-labelledby="saved-scripts-h"
      className="control-panel show-queue"
    >
      <header className="queue-heading">
        <div>
          <h2 id="saved-scripts-h">Show queue</h2>
          <span>
            {list.length === 0 ? '∅' : `(${list.length})`}
          </span>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="queue-new"
        >
          + new
        </button>
      </header>

      {list.length === 0 ? (
        <div className="empty-queue">
          // no scripts on deck
        </div>
      ) : (
        <ul className="paper-stack">
          {list.map((s) => (
            <ScriptRow
              key={s.id}
              script={s}
              isActive={s.id === activeId}
              onLoad={() => onLoad(s.id)}
              onDelete={() => onDelete(s)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ScriptRow({
  script: s,
  isActive,
  onLoad,
  onDelete,
}: {
  script: Script;
  isActive: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const wordCount = (s.text.trim().match(/\S+/g) || []).length;
  const snippet = (s.text || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const date = useMemo(
    () =>
      new Date(s.updatedAt).toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
      }),
    [s.updatedAt]
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      onDelete();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const li = e.currentTarget.closest('li');
      const sibling =
        e.key === 'ArrowDown' ? li?.nextElementSibling : li?.previousElementSibling;
      const next = sibling?.querySelector<HTMLButtonElement>('[data-row-main]');
      next?.focus();
    }
  }

  return (
    <li
      className={`queue-card group ${
        isActive ? 'is-active' : ''
      }`}
    >
      <button
        type="button"
        data-row-main
        onClick={onLoad}
        onKeyDown={handleKeyDown}
        className="queue-card-main"
        aria-current={isActive ? 'true' : undefined}
        aria-label={`Load script: ${s.title || 'Untitled'}`}
      >
        <div className="queue-card-title">
          {isActive ? (
            <span
              className="queue-dot live-dot"
              style={{ boxShadow: '0 0 6px rgba(255,45,45,0.6)' }}
              aria-label="active"
            />
          ) : (
            <span className="queue-dot" />
          )}
          <span>
            {s.title || 'Untitled'}
          </span>
          {isActive && (
            <span className="queue-live">
              · live
            </span>
          )}
        </div>
        <div className="queue-card-meta">
          <span>{wordCount}w</span>
          <span>·</span>
          <span>{date}</span>
          {snippet && (
            <>
              <span>·</span>
              <span className="queue-snippet">
                {snippet}
                {s.text.length > 70 ? '…' : ''}
              </span>
            </>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }
        }}
        className="queue-delete"
        aria-label={`Delete script: ${s.title || 'Untitled'}`}
        title="Delete (Backspace)"
      >
        delete
      </button>
    </li>
  );
}

function UndoToast({
  label,
  onUndo,
  onDismiss,
}: {
  label: React.ReactNode;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="undo-toast fade-up"
    >
      <span>{label}</span>
      <button
        type="button"
        onClick={onUndo}
        className="undo-button"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="undo-dismiss"
      >
        ×
      </button>
    </div>
  );
}

function Logo() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="1" y="1" width="62" height="62" rx="11" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.10)" />
      <rect x="13" y="15" width="38" height="26" rx="3" fill="none" stroke="#ffffff" strokeWidth="2.2" />
      <rect x="18" y="21" width="20" height="2.4" rx="1" fill="#ffffff" />
      <rect x="18" y="27" width="26" height="2.4" rx="1" fill="#ffffff" opacity="0.7" />
      <rect x="18" y="33" width="12" height="2.4" rx="1" fill="#ffffff" opacity="0.45" />
      <path d="M22 48 L42 48 L36 55 L28 55 Z" fill="#ffffff" />
      <circle cx="49" cy="15" r="3.5" fill="#ff2d2d">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
