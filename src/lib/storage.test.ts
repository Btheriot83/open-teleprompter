import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Script,
  loadAll,
  saveAll,
  getActiveId,
  setActiveId,
  removeScript,
  upsertScript,
  updateScriptIfExists,
} from './storage';

function mk(id: string, title = id, text = ''): Script {
  return { id, title, text, updatedAt: Date.now() };
}

beforeEach(() => {
  localStorage.clear();
});

describe('storage primitives', () => {
  it('loadAll returns [] when storage is empty', () => {
    expect(loadAll()).toEqual([]);
  });

  it('loadAll tolerates malformed JSON', () => {
    localStorage.setItem('tp.scripts.v1', '{not json');
    expect(loadAll()).toEqual([]);
  });

  it('loadAll tolerates a non-array payload', () => {
    localStorage.setItem('tp.scripts.v1', '{"oops":true}');
    expect(loadAll()).toEqual([]);
  });

  it('saveAll then loadAll round-trips', () => {
    const data = [mk('a'), mk('b')];
    saveAll(data);
    expect(loadAll()).toEqual(data);
  });

  it('setActiveId / getActiveId round-trips', () => {
    setActiveId('xyz');
    expect(getActiveId()).toBe('xyz');
    setActiveId(null);
    expect(getActiveId()).toBeNull();
  });
});

describe('removeScript', () => {
  it('removes the script with the given id', () => {
    saveAll([mk('a'), mk('b'), mk('c')]);
    const remaining = removeScript('b');
    expect(remaining.map((s) => s.id)).toEqual(['a', 'c']);
    expect(loadAll().map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('reassigns activeId when the active script is removed', () => {
    saveAll([mk('a'), mk('b'), mk('c')]);
    setActiveId('b');
    removeScript('b');
    expect(getActiveId()).toBe('a');
  });

  it('clears activeId when removing the only remaining script', () => {
    saveAll([mk('only')]);
    setActiveId('only');
    removeScript('only');
    expect(getActiveId()).toBeNull();
    expect(loadAll()).toEqual([]);
  });

  it('leaves activeId alone when removing a non-active script', () => {
    saveAll([mk('a'), mk('b')]);
    setActiveId('a');
    removeScript('b');
    expect(getActiveId()).toBe('a');
  });
});

describe('upsertScript', () => {
  it('inserts a new script at the head of the list', () => {
    saveAll([mk('a')]);
    upsertScript(mk('b'));
    expect(loadAll().map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('updates an existing script in place', () => {
    saveAll([mk('a', 'first', 'old')]);
    upsertScript(mk('a', 'first', 'new'));
    expect(loadAll()[0].text).toBe('new');
  });
});

describe('updateScriptIfExists', () => {
  it('returns true and updates when the script exists', () => {
    saveAll([mk('a', 'A', 'before')]);
    const ok = updateScriptIfExists(mk('a', 'A', 'after'));
    expect(ok).toBe(true);
    expect(loadAll()[0].text).toBe('after');
  });

  it('returns false and does NOT resurrect a removed script', () => {
    saveAll([mk('a')]);
    removeScript('a');
    const ok = updateScriptIfExists(mk('a', 'A', 'should-not-appear'));
    expect(ok).toBe(false);
    expect(loadAll()).toEqual([]);
  });
});

describe('delete bug regression — stale-list clobber', () => {
  // The old bug: a UI component held a stale copy of the all-scripts list and
  // wrote it back via saveAll(...) when deleting any single script. That clobbered
  // freshly-saved edits to other scripts. The fix is atomic removeScript().
  it('removeScript preserves recent updates to other scripts', () => {
    // Initial seeded state — both scripts are at v0.
    saveAll([mk('a', 'A', 'a-v0'), mk('b', 'B', 'b-v0')]);

    // "UI" component captures a stale snapshot at this point.
    const staleSnapshot = loadAll();

    // The active script (a) gets typing persisted via App's debounce.
    upsertScript({ ...staleSnapshot[0], text: 'a-v1' });
    expect(loadAll().find((s) => s.id === 'a')?.text).toBe('a-v1');

    // Old bug repro: user deletes the OTHER script. With the old code, the UI
    // would do `saveAll(staleSnapshot.filter(x => x.id !== 'b'))` here, which
    // would put 'a' back to 'a-v0'. With atomic removeScript() it stays at v1.
    removeScript('b');

    const after = loadAll();
    expect(after.map((s) => s.id)).toEqual(['a']);
    expect(after[0].text).toBe('a-v1');
  });
});
