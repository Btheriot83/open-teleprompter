import { describe, expect, it } from 'vitest';
import { durationFromWpm, getModeWpm } from '../lib/settings';

describe('editor timing controls', () => {
  it('derives timed-mode WPM from word count and duration', () => {
    expect(getModeWpm({ mode: 'timed', speed: 60, durationSec: 120 }, 240)).toBe(120);
  });

  it('derives fixed-mode WPM from pixel speed', () => {
    expect(getModeWpm({ mode: 'fixed', speed: 80, durationSec: 120 }, 240)).toBe(60);
  });

  it('converts WPM changes into timed duration changes', () => {
    expect(durationFromWpm(240, 120)).toBe(120);
    expect(durationFromWpm(240, 60)).toBe(240);
  });
});
