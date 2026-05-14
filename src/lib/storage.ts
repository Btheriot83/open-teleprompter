export type Script = {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
};

const KEY = 'tp.scripts.v1';
const ACTIVE = 'tp.activeId.v1';

export function loadAll(): Script[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Script[]) : [];
  } catch {
    return [];
  }
}

export function saveAll(scripts: Script[]) {
  localStorage.setItem(KEY, JSON.stringify(scripts));
}

export function getActiveId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(ACTIVE);
}

export function setActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE, id);
  else localStorage.removeItem(ACTIVE);
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// --- Atomic single-item ops ----------------------------------------------
// Always read storage fresh, mutate one record, and write back. This
// prevents stale in-memory script lists from clobbering recent edits to
// other scripts in the same store.

export function removeScript(id: string): Script[] {
  const remaining = loadAll().filter((s) => s.id !== id);
  saveAll(remaining);
  if (getActiveId() === id) setActiveId(remaining[0]?.id ?? null);
  return remaining;
}

export function upsertScript(script: Script): Script[] {
  const all = loadAll();
  const idx = all.findIndex((s) => s.id === script.id);
  if (idx >= 0) all[idx] = script;
  else all.unshift(script);
  saveAll(all);
  return all;
}

// Update an existing script only — never resurrects a removed record.
export function updateScriptIfExists(script: Script): boolean {
  const all = loadAll();
  const idx = all.findIndex((s) => s.id === script.id);
  if (idx < 0) return false;
  all[idx] = script;
  saveAll(all);
  return true;
}
