import { describe, expect, it } from 'vitest';
import {
  advanceVoiceAssistCursor,
  computeFixedScrollTop,
  computeTimedScrollTop,
  findVoiceMatchIndex,
  isVoiceLevelSpeaking,
  normalizeWords,
  reduceVoiceMachine,
  tokenizeWords,
} from './Prompter';
import { durationFromWpm, getModeWpm } from '../lib/settings';

const voiceTestScript = `
Good morning and welcome to the live voice tracking test. This script is
intentionally long enough to create visible scrolling in the teleprompter.
Start reading from the beginning, and keep your pace steady so the voice
tracker can match the words you are saying.
`;

describe('voice tracking matcher', () => {
  it('catches up when the first speech event arrives beyond the old short lookahead', () => {
    const tokens = tokenizeWords(voiceTestScript);
    const heard = normalizeWords('start reading from the beginning');

    const match = findVoiceMatchIndex(tokens, 0, heard);

    expect(match).toBeGreaterThan(12);
    expect(tokens[match].word).toBe('beginning');
  });

  it('continues from the current cursor using recent phrase context', () => {
    const tokens = tokenizeWords(voiceTestScript);
    const cursor = tokens.findIndex((token) => token.word === 'teleprompter');
    const heard = normalizeWords('keep your pace steady');

    const match = findVoiceMatchIndex(tokens, cursor, heard);

    expect(match).toBeGreaterThan(cursor);
    expect(tokens[match].word).toBe('steady');
  });

  it('advances the assist cursor by speaking cadence when transcripts are unavailable', () => {
    const nextCursor = advanceVoiceAssistCursor(0, 2, 60, 20);

    expect(nextCursor).toBeGreaterThan(3);
    expect(nextCursor).toBeLessThanOrEqual(19);
  });

  it('does not advance before the mic-ready countdown has armed voice mode', () => {
    const state = reduceVoiceMachine(
      { phase: 'arming', cursor: 0, armed: false },
      { type: 'speech_detected', cursor: 4 }
    );

    expect(state.phase).toBe('arming');
    expect(state.cursor).toBe(0);
  });

  it('advances from transcript matches after arming', () => {
    const state = reduceVoiceMachine(
      { phase: 'ready', cursor: 0, armed: true },
      { type: 'transcript_match', cursor: 12 }
    );

    expect(state.phase).toBe('matching');
    expect(state.cursor).toBe(12);
  });

  it('advances from no-transcript voice assist after arming', () => {
    const state = reduceVoiceMachine(
      { phase: 'ready', cursor: 2, armed: true },
      { type: 'speech_detected', cursor: 6 }
    );

    expect(state.phase).toBe('assist');
    expect(state.cursor).toBe(6);
  });

  it('pauses the fallback when speech ends', () => {
    const state = reduceVoiceMachine(
      { phase: 'assist', cursor: 8, armed: true },
      { type: 'speech_ended' }
    );

    expect(state.phase).toBe('paused');
    expect(state.cursor).toBe(8);
  });

  it('surfaces blocked microphone or browser state', () => {
    const state = reduceVoiceMachine(
      { phase: 'ready', cursor: 8, armed: true },
      { type: 'blocked' }
    );

    expect(state.phase).toBe('blocked');
    expect(state.armed).toBe(false);
  });

  it('classifies real mic levels above the voice threshold as speaking', () => {
    expect(isVoiceLevelSpeaking(0.05)).toBe(true);
    expect(isVoiceLevelSpeaking(0.01)).toBe(false);
  });
});

describe('timed scrolling', () => {
  it('maps elapsed time to proportional scroll position', () => {
    expect(computeTimedScrollTop(0, 120, 1000)).toBe(0);
    expect(computeTimedScrollTop(30, 120, 1000)).toBe(250);
    expect(computeTimedScrollTop(120, 120, 1000)).toBe(1000);
  });

  it('clamps timed scroll at the bottom instead of overshooting', () => {
    expect(computeTimedScrollTop(180, 120, 1000)).toBe(1000);
  });

  it('changes timed scroll position when WPM changes duration', () => {
    const wordCount = 120;
    const slowDuration = durationFromWpm(wordCount, 60);
    const fastDuration = durationFromWpm(wordCount, 120);

    expect(getModeWpm({ mode: 'timed', speed: 60, durationSec: fastDuration }, wordCount)).toBe(120);
    expect(computeTimedScrollTop(30, fastDuration, 1000)).toBeGreaterThan(
      computeTimedScrollTop(30, slowDuration, 1000)
    );
  });
});

describe('fixed scrolling', () => {
  it('accumulates sub-pixel frame movement instead of dropping it to scrollTop rounding', () => {
    let top = 0;
    for (let i = 0; i < 10; i += 1) {
      top = computeFixedScrollTop(top, 0.016, 10, 1000);
    }

    expect(top).toBeGreaterThan(1.5);
  });

  it('clamps fixed scroll at the bottom', () => {
    expect(computeFixedScrollTop(990, 1, 60, 1000)).toBe(1000);
  });
});
