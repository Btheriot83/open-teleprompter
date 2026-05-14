import { useEffect, useRef, useState } from 'react';
import Editor from './Editor';
import Prompter from './Prompter';
import {
  type Script,
  loadAll,
  saveAll,
  getActiveId,
  setActiveId,
  newId,
  updateScriptIfExists,
} from '../lib/storage';
import { type Settings, loadSettings, saveSettings } from '../lib/settings';

function ensureScript(): Script {
  const all = loadAll();
  const id = getActiveId();
  const existing = id ? all.find((s) => s.id === id) : null;
  if (existing) return existing;
  if (all[0]) {
    setActiveId(all[0].id);
    return all[0];
  }
  const s: Script = {
    id: newId(),
    title: 'Untitled',
    text: '',
    updatedAt: Date.now(),
  };
  saveAll([s]);
  setActiveId(s.id);
  return s;
}

export default function App() {
  const [view, setView] = useState<'editor' | 'prompter'>('editor');
  const [script, setScript] = useState<Script | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    setScript(ensureScript());
    setSettings(loadSettings());
  }, []);

  // Persist script (debounced). Only updates an EXISTING record — if the
  // script was deleted while the debounce was in flight, the write is
  // dropped so we never resurrect a removed entry.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!script) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const saved = updateScriptIfExists(script);
      if (saved) setActiveId(script.id);
    }, 250);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [script]);

  // Persist settings
  useEffect(() => {
    if (settings) saveSettings(settings);
  }, [settings]);

  if (!script || !settings) {
    return <div className="p-6 text-neutral-500">Loading…</div>;
  }

  if (view === 'prompter') {
    return (
      <Prompter
        script={script}
        settings={settings}
        onSettings={setSettings}
        onExit={() => setView('editor')}
      />
    );
  }

  return (
    <Editor
      script={script}
      onChange={setScript}
      settings={settings}
      onSettings={setSettings}
      onStartPrompter={() => setView('prompter')}
    />
  );
}
