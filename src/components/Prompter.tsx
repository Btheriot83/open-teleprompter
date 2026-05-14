import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Settings,
  type Mirror,
  FONT_STACKS,
  durationFromWpm,
  getModeWpm,
  mirrorTransform,
  nextMirror,
} from '../lib/settings';
import { type Script } from '../lib/storage';
import { useRecorder } from '../lib/recorder';

type Props = {
  script: Script;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onExit: () => void;
};

export default function Prompter({ script, settings, onSettings, onExit }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const voiceFallbackTimerRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  const fixedScrollTopRef = useRef<number>(0);
  const timedStartedAtRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [timedElapsedSec, setTimedElapsedSec] = useState(0);
  const voiceDebugEnabled = useMemo(
    () =>
      import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('voiceDebug'),
    []
  );

  const recorder = useRecorder({
    onStartRecording: useCallback(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setPlaying(true);
    }, []),
    onStopRecording: useCallback(() => {
      setPlaying(false);
    }, []),
  });
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const stream = 'stream' in recorder.state ? recorder.state.stream : null;
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    if (stream) {
      v.srcObject = stream;
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [stream]);

  // Fixed/timed scroll loop. Voice mode handled in separate effect below.
  useEffect(() => {
    if (!playing) return;
    if (settings.mode !== 'fixed' && settings.mode !== 'timed') return;

    const el = scrollRef.current;
    if (!el) return;

    lastTickRef.current = performance.now();
    if (settings.mode === 'timed') {
      timedStartedAtRef.current = lastTickRef.current;
      setTimedElapsedSec(0);
    } else {
      fixedScrollTopRef.current = el.scrollTop;
    }
    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      if (el) {
        if (settings.mode === 'timed') {
          const elapsed = (now - timedStartedAtRef.current) / 1000;
          const total = Math.max(0, el.scrollHeight - el.clientHeight);
          el.scrollTop = computeTimedScrollTop(elapsed, settings.durationSec, total);
          setTimedElapsedSec(elapsed);
        } else {
          const total = Math.max(0, el.scrollHeight - el.clientHeight);
          fixedScrollTopRef.current = computeFixedScrollTop(
            fixedScrollTopRef.current,
            dt,
            settings.speed,
            total
          );
          el.scrollTop = fixedScrollTopRef.current;
        }
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, settings.mode, settings.speed, settings.durationSec]);

  // Voice-tracked scroll: SpeechRecognition matches latest spoken words to script position.
  const [voiceStatus, setVoiceStatus] = useState<VoicePhase>('idle');
  const [voiceTrace, setVoiceTrace] = useState('');
  const [voiceCountdown, setVoiceCountdown] = useState<number | null>(null);
  const [voiceCursor, setVoiceCursor] = useState(0);
  useEffect(() => {
    if (!playing || settings.mode !== 'voice') return;
    const SR =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    const el = scrollRef.current;
    if (!el) return;

    // Tokenize script into normalized words with character offsets
    const tokens = tokenizeWords(script.text);
    if (tokens.length === 0) return;

    // Cursor: index into tokens of "next expected word"
    const cursorRef = { current: 0 };
    const assistCursorRef = { current: 0 };
    setVoiceCursor(0);
    let fallbackTickAt = 0;
    let fallbackRunning = false;
    let armed = false;
    let countdownTimer: number | null = null;
    let countdownInterval: number | null = null;
    let stopped = false;
    let rec: any = null;
    let micStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let vadFrame: number | null = null;
    let speaking = false;
    let debugSpeaking = false;
    let quietFrames = 0;

    const stopFallbackScroll = () => {
      fallbackRunning = false;
      fallbackTickAt = 0;
      if (voiceFallbackTimerRef.current) {
        window.clearInterval(voiceFallbackTimerRef.current);
        voiceFallbackTimerRef.current = null;
      }
    };

    const startAssistScroll = () => {
      if (!fallbackRunning) {
        fallbackRunning = true;
        fallbackTickAt = performance.now();
        const tick = () => {
          if (!fallbackRunning) return;
          const now = performance.now();
          const dt = (now - fallbackTickAt) / 1000;
          fallbackTickAt = now;
          assistCursorRef.current = advanceVoiceAssistCursor(
            assistCursorRef.current,
            dt,
            settings.speed,
            tokens.length
          );
          cursorRef.current = Math.max(cursorRef.current, Math.floor(assistCursorRef.current));
          setVoiceCursor(cursorRef.current);
          scrollToToken(el, tokens[cursorRef.current]);
        };
        voiceFallbackTimerRef.current = window.setInterval(tick, 100);
      }
    };

    const clearCountdown = () => {
      if (countdownTimer) {
        window.clearTimeout(countdownTimer);
        countdownTimer = null;
      }
      if (countdownInterval) {
        window.clearInterval(countdownInterval);
        countdownInterval = null;
      }
      setVoiceCountdown(null);
    };

    const startReadyCountdown = (trace = 'Mic armed - wait for cue') => {
      clearCountdown();
      armed = false;
      let remaining = 3;
      setVoiceStatus('arming');
      setVoiceCountdown(remaining);
      setVoiceTrace(trace);
      countdownInterval = window.setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          setVoiceCountdown(remaining);
        }
      }, 1000);
      countdownTimer = window.setTimeout(() => {
        clearCountdown();
        armed = true;
        setVoiceStatus('ready');
        setVoiceTrace(SR ? 'Speak now - matching words' : 'Speak now - Voice Assist');
      }, 3000);
    };

    const handleResult = (event: any) => {
      if (!armed) return;
      stopFallbackScroll();
      // Pull latest interim/final transcript
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript + ' ';
      }
      const heard = normalizeWords(transcript);
      if (heard.length === 0) return;
      setVoiceStatus('matching');
      setVoiceTrace(`Heard: ${heard.slice(-8).join(' ')}`);

      const bestIdx = findVoiceMatchIndex(tokens, cursorRef.current, heard);
      if (bestIdx >= 0) {
        cursorRef.current = bestIdx + 1;
        assistCursorRef.current = cursorRef.current;
        setVoiceCursor(cursorRef.current);
        scrollToToken(el, tokens[bestIdx]);
      } else {
        setVoiceTrace(`Heard, no match: ${heard.slice(-8).join(' ')}`);
      }
    };

    const handleTranscriptText = (text: string) => {
      if (!armed) return;
      stopFallbackScroll();
      const heard = normalizeWords(text);
      if (heard.length === 0) return;
      setVoiceStatus('matching');
      setVoiceTrace(`Heard: ${heard.slice(-8).join(' ')}`);

      const bestIdx = findVoiceMatchIndex(tokens, cursorRef.current, heard);
      if (bestIdx >= 0) {
        cursorRef.current = bestIdx + 1;
        assistCursorRef.current = cursorRef.current;
        setVoiceCursor(cursorRef.current);
        scrollToToken(el, tokens[bestIdx]);
      } else {
        setVoiceTrace(`Heard, no match: ${heard.slice(-8).join(' ')}`);
      }
    };

    const sampleMic = () => {
      if (stopped || !analyser) return;
      const level = readMicLevel(analyser);
      const nextSpeaking = debugSpeaking || isVoiceLevelSpeaking(level);

      if (!armed) {
        if (nextSpeaking) setVoiceTrace('Hold - mic is arming');
      } else if (nextSpeaking) {
        quietFrames = 0;
        if (!speaking) {
          speaking = true;
          setVoiceStatus(SR ? 'assist' : 'assist');
          setVoiceTrace(SR ? 'Voice Assist active - waiting for transcript' : 'Voice Assist active');
          startAssistScroll();
        }
      } else if (speaking) {
        quietFrames += 1;
        if (quietFrames >= 14) {
          speaking = false;
          quietFrames = 0;
          stopFallbackScroll();
          setVoiceStatus('paused');
          setVoiceTrace('Paused - speak again to continue');
        }
      }

      vadFrame = requestAnimationFrame(sampleMic);
    };

    const onDebugReady = () => {
      clearCountdown();
      armed = true;
      setVoiceStatus('ready');
      setVoiceTrace('Debug ready - speak now');
    };
    const onDebugTranscript = (event: Event) => {
      handleTranscriptText((event as CustomEvent<string>).detail ?? '');
    };
    const onDebugSpeechStart = () => {
      if (!armed) return;
      debugSpeaking = true;
      speaking = true;
      setVoiceStatus('assist');
      setVoiceTrace('Debug Voice Assist active');
      startAssistScroll();
    };
    const onDebugSpeechStop = () => {
      debugSpeaking = false;
      speaking = false;
      stopFallbackScroll();
      setVoiceStatus('paused');
      setVoiceTrace('Debug paused - speech stopped');
    };

    window.addEventListener('teleprompter:voice-ready', onDebugReady);
    window.addEventListener('teleprompter:voice-transcript', onDebugTranscript);
    window.addEventListener('teleprompter:voice-speech-start', onDebugSpeechStart);
    window.addEventListener('teleprompter:voice-speech-stop', onDebugSpeechStop);

    const startRecognition = () => {
      if (!SR) return;
      try {
        rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'en-US';
        rec.onresult = handleResult;
        rec.onerror = (e: any) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            setVoiceStatus('blocked');
            setVoiceTrace(e.error);
          } else if (e.error && e.error !== 'no-speech') {
            setVoiceTrace(`SpeechRecognition: ${e.error}`);
          }
        };
        rec.onend = () => {
          if (!stopped && playing && settings.mode === 'voice') {
            try {
              rec.start();
            } catch {}
          }
        };
        rec.start();
      } catch {
        setVoiceTrace('SpeechRecognition unavailable - Voice Assist only');
      }
    };

    const bootVoice = async () => {
      setVoiceStatus('arming');
      setVoiceTrace('Requesting microphone');
      try {
        const AC =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!navigator.mediaDevices?.getUserMedia || !AC) {
          setVoiceStatus('blocked');
          setVoiceTrace('Microphone APIs unavailable in this browser');
          return;
        }
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) return;
        audioCtx = new AC();
        const source = audioCtx.createMediaStreamSource(micStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        startRecognition();
        startReadyCountdown(SR ? 'Mic armed - wait for cue' : 'Mic armed - Voice Assist only');
        vadFrame = requestAnimationFrame(sampleMic);
      } catch (error) {
        setVoiceStatus('blocked');
        setVoiceTrace(error instanceof Error ? error.message : 'Microphone blocked');
      }
    };

    void bootVoice();

    return () => {
      stopped = true;
      try {
        clearCountdown();
        stopFallbackScroll();
        if (vadFrame) cancelAnimationFrame(vadFrame);
        if (rec) {
          rec.onresult = null;
          rec.onend = null;
          rec.onerror = null;
          rec.stop();
        }
        micStream?.getTracks().forEach((track) => track.stop());
        void audioCtx?.close();
        window.removeEventListener('teleprompter:voice-ready', onDebugReady);
        window.removeEventListener('teleprompter:voice-transcript', onDebugTranscript);
        window.removeEventListener('teleprompter:voice-speech-start', onDebugSpeechStart);
        window.removeEventListener('teleprompter:voice-speech-stop', onDebugSpeechStop);
      } catch {}
      setVoiceStatus('idle');
      setVoiceTrace('');
      setVoiceCountdown(null);
    };
  }, [playing, settings.mode, settings.speed, script.text]);

  // Keyboard remote
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip if typing in inputs (settings panel)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currentWordCount = (script.text.trim().match(/\S+/g) || []).length;
        if (settings.mode === 'timed') {
          const nextWpm = Math.min(240, getModeWpm(settings, currentWordCount) + 5);
          onSettings({ ...settings, durationSec: durationFromWpm(currentWordCount, nextWpm) });
        } else {
          onSettings({ ...settings, speed: Math.min(400, settings.speed + 10) });
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const currentWordCount = (script.text.trim().match(/\S+/g) || []).length;
        if (settings.mode === 'timed') {
          const nextWpm = Math.max(20, getModeWpm(settings, currentWordCount) - 5);
          onSettings({ ...settings, durationSec: durationFromWpm(currentWordCount, nextWpm) });
        } else {
          onSettings({ ...settings, speed: Math.max(10, settings.speed - 10) });
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onSettings({ ...settings, fontSize: Math.min(160, settings.fontSize + 4) });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onSettings({ ...settings, fontSize: Math.max(16, settings.fontSize - 4) });
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        onSettings({ ...settings, mirror: nextMirror(settings.mirror) });
      } else if (e.key === 'Escape') {
        setPlaying(false);
        if (showSettings) setShowSettings(false);
        else onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings, onSettings, onExit, showSettings]);

  const wordCount = useMemo(
    () => (script.text.trim().match(/\S+/g) || []).length,
    [script.text]
  );
  const voiceDebugTranscript = useMemo(() => {
    const words = tokenizeWords(script.text).slice(3, 10).map((token) => token.word);
    return words.length ? words.join(' ') : 'no script yet';
  }, [script.text]);

  // Live scroll position — drives timecode + progress bar.
  const [scrollState, setScrollState] = useState({ top: 0, max: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      setScrollState({ top: el.scrollTop, max });
    };
    measure();
    const onScroll = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      setScrollState({ top: el.scrollTop, max });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [script.text, settings.fontSize, settings.lineHeight, settings.fontFamily]);

  const progress = scrollState.max > 0 ? scrollState.top / scrollState.max : 0;

  // Elapsed + total timecodes (mode-aware).
  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(Math.max(0, s) % 60)
      .toString()
      .padStart(2, '0')}`;
  const totalSecEstimate = useMemo(() => {
    if (settings.mode === 'timed') return settings.durationSec;
    if (settings.mode === 'voice') return 0;
    // fixed: prefer real scroll dimensions when available
    if (scrollState.max > 0) return scrollState.max / Math.max(1, settings.speed);
    const wordsPerSec = settings.speed / 80;
    return wordCount / Math.max(0.1, wordsPerSec);
  }, [settings.mode, settings.speed, settings.durationSec, scrollState.max, wordCount]);
  const elapsedSec = useMemo(() => {
    if (settings.mode === 'timed') return playing ? timedElapsedSec : progress * settings.durationSec;
    if (settings.mode === 'voice') return progress * 0; // unknown total
    return scrollState.top / Math.max(1, settings.speed);
  }, [playing, settings.mode, settings.speed, settings.durationSec, progress, scrollState.top, timedElapsedSec]);
  const timecodeStr =
    settings.mode === 'voice'
      ? `${Math.round(progress * 100)}%`
      : `${fmtTime(elapsedSec)} / ${fmtTime(totalSecEstimate)}`;
  const scriptFontFamily =
    settings.fontFamily === 'sans' || settings.fontFamily === 'system'
      ? 'var(--font-prompter)'
      : FONT_STACKS[settings.fontFamily];

  return (
    <div
      className="stage-prompter fixed inset-0 overflow-hidden"
      style={{ background: settings.bgColor, color: settings.textColor }}
    >
      <div className="film-strip" aria-hidden="true" />
      <div
        className="progress-bar"
        style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
      />

      <div className="stage-topbar">
        <div className="stage-cluster stage-left">
          <button
            type="button"
            onClick={onExit}
            className="stage-chip ghost"
            aria-label="Exit prompter"
          >
            ← Exit
          </button>
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className={`stage-chip transport ${playing ? 'is-playing' : ''}`}
          >
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
              setVoiceCursor(0);
              setPlaying(false);
            }}
            className="stage-chip ghost"
          >
            ↺ Restart
          </button>
        </div>

        <div className="stage-live-core" aria-label="Live teleprompter status">
          <span className={`stage-state ${playing ? 'is-live' : ''}`}>
            <span className="live-dot" />
            {playing ? 'On air' : 'Standby'}
          </span>
          <span
            className={`stage-timecode ${
              playing ? 'tc-live' : ''
            }`}
            title={settings.mode === 'voice' ? 'progress' : 'elapsed / total'}
          >
            {timecodeStr}
          </span>
          <span className="stage-script-title">{script.title || 'Untitled'}</span>
        </div>

        <div className="stage-actions">
          <select
            value={settings.mode}
            onChange={(e) => onSettings({ ...settings, mode: e.target.value as Settings['mode'] })}
            className="stage-select"
          >
            <option value="fixed">Fixed</option>
            <option value="timed">Timed</option>
            <option value="voice">Voice</option>
          </select>
          <span className="stage-word-count">{wordCount}w</span>
          {settings.mode === 'voice' && (
            <span
              className={`stage-voice-pill ${
                voiceStatus === 'ready' || voiceStatus === 'matching'
                  ? 'voice-on'
                  : voiceStatus === 'assist'
                    ? 'voice-assist'
                  : voiceStatus === 'arming'
                    ? 'voice-arming'
                  : voiceStatus === 'blocked'
                    ? 'voice-warn'
                  : voiceStatus === 'paused'
                    ? 'voice-paused'
                    : 'voice-idle'
              }`}
              title={
                voiceStatus === 'blocked'
                  ? 'Microphone permission or browser voice APIs are unavailable.'
                  : ''
              }
            >
              {voiceStatus === 'ready'
                ? '● Listening'
                : voiceStatus === 'matching'
                  ? '● Matching'
                : voiceStatus === 'assist'
                  ? '● Voice Assist'
                : voiceStatus === 'arming' && voiceCountdown
                  ? `Speak in ${voiceCountdown}`
                  : voiceStatus === 'blocked'
                    ? 'Mic blocked'
                  : voiceStatus}
            </span>
          )}
          {settings.mode === 'voice' && voiceTrace && (
            <span className="stage-voice-trace">{voiceTrace}</span>
          )}
          <RecordControls recorder={recorder} />
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="stage-chip ghost"
            title="Settings · mirror, size, voice, colors"
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {stream && (
        <div className="camera-viewfinder">
          <video
            ref={previewVideoRef}
            muted
            playsInline
            className="camera-feed"
            style={{ transform: settings.cameraMirror ? 'scaleX(-1)' : 'none' }}
          />
          {recorder.state.kind === 'recording' && (
            <div className="rec-badge">
              <span className="live-dot pulse-dot" />
              REC
            </div>
          )}
          <div className="preview-label">
            {settings.cameraMirror ? 'preview mirrored' : 'preview'}
          </div>
        </div>
      )}

      {recorder.state.kind === 'countdown' && (
        <div className="countdown-shutter">
          <div
            className="countdown-number"
            key={recorder.state.secondsLeft}
          >
            {recorder.state.secondsLeft || 'GO'}
          </div>
        </div>
      )}

      {recorder.state.kind === 'error' && (
        <div className="stage-error">
          {recorder.state.message}
        </div>
      )}

      <div
        ref={scrollRef}
        data-token-count={(script.text.match(/[A-Za-z0-9']+/g) || []).length}
        className="stage-scroll"
        style={{
          transform: mirrorTransform(settings.mirror),
          transformOrigin: 'center center',
          scrollbarWidth: 'none',
        }}
      >
        <div
          className="stage-script"
          style={{
            fontFamily: scriptFontFamily,
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            textAlign: settings.align,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            maxWidth: '100%',
          }}
        >
          {settings.mode === 'voice' && script.text
            ? renderVoiceText(script.text, voiceCursor)
            : script.text || 'No script yet — paste or import some text in the editor.'}
        </div>
      </div>

      {settings.readingGuide === 'chevron' && (
        <>
          <span
            className={`cue-chevron left ${playing ? 'live' : ''}`}
            style={{ fontSize: `${Math.max(20, Math.min(40, settings.fontSize * 0.55))}px` }}
            aria-hidden="true"
          >
            ▶
          </span>
          <span
            className="cue-chevron right"
            style={{ fontSize: `${Math.max(16, Math.min(34, settings.fontSize * 0.45))}px` }}
            aria-hidden="true"
          >
            ◀
          </span>
        </>
      )}
      {settings.readingGuide === 'line' && (
        <div
          className="reading-line"
          style={{
            borderTop: `2px solid ${settings.textColor}`,
          }}
        />
      )}

      {voiceDebugEnabled && settings.mode === 'voice' && (
        <div className="voice-debug-panel" aria-label="Voice debug harness">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('teleprompter:voice-ready'))}
          >
            Debug ready
          </button>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('teleprompter:voice-transcript', {
                  detail: voiceDebugTranscript,
                })
              )
            }
          >
            Fake transcript
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('teleprompter:voice-speech-start'))}
          >
            Fake speech
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('teleprompter:voice-speech-stop'))}
          >
            Stop speech
          </button>
        </div>
      )}

      {settings.edgeFade && (
        <>
          <div
            className="stage-edge top"
            style={{
              background: `linear-gradient(to bottom, ${settings.bgColor}, transparent)`,
            }}
          />
          <div
            className="stage-edge bottom"
            style={{
              background: `linear-gradient(to top, ${settings.bgColor}, transparent)`,
            }}
          />
        </>
      )}

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          settings={settings}
          wordCount={wordCount}
          onSettings={onSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function SettingsPanel({
  settings,
  wordCount,
  onSettings,
  onClose,
}: {
  settings: Settings;
  wordCount: number;
  onSettings: (s: Settings) => void;
  onClose: () => void;
}) {
  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    onSettings({ ...settings, [k]: v });
  }
  return (
    <div className="stage-settings-panel"
      style={{ backdropFilter: 'blur(14px)' }}
    >
      <div className="stage-settings-head">
        <h2
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          Prompt controls
        </h2>
        <button
          onClick={onClose}
          className="settings-close"
          aria-label="Close settings"
        >×</button>
      </div>

      {settings.mode === 'timed' && (
        <div className="stage-mode-note">
          Set a target finish time. Timed mode adjusts pace so the whole script lands there.
        </div>
      )}

      {settings.mode === 'timed' ? (
        <Row label={`Reading pace: ${getModeWpm(settings, wordCount)} wpm`}>
          <input
            type="range"
            min={20}
            max={240}
            step={5}
            value={getModeWpm(settings, wordCount)}
            onChange={(e) => set('durationSec', durationFromWpm(wordCount, +e.target.value))}
            className="w-full accent"
          />
        </Row>
      ) : (
        <Row label={`Speed: ${settings.speed} px/s`}>
          <input type="range" min={10} max={400} step={5} value={settings.speed}
            onChange={(e) => set('speed', +e.target.value)} className="w-full accent" />
        </Row>
      )}

      {settings.mode === 'timed' && (
        <Row label={`Target time: ${Math.floor(settings.durationSec / 60)}:${(settings.durationSec % 60).toString().padStart(2, '0')}`}>
          <input type="range" min={15} max={1800} step={15} value={settings.durationSec}
            onChange={(e) => set('durationSec', +e.target.value)} className="w-full accent" />
        </Row>
      )}

      <Row label={`Font size: ${settings.fontSize}px`}>
        <input type="range" min={16} max={160} step={2} value={settings.fontSize}
          onChange={(e) => set('fontSize', +e.target.value)} className="w-full accent" />
      </Row>

      <Row label={`Line height: ${settings.lineHeight.toFixed(2)}`}>
        <input type="range" min={1} max={2.4} step={0.05} value={settings.lineHeight}
          onChange={(e) => set('lineHeight', +e.target.value)} className="w-full accent" />
      </Row>

      <Row label="Font family">
        <select value={settings.fontFamily}
          onChange={(e) => set('fontFamily', e.target.value as Settings['fontFamily'])}
          className="stage-select wide">
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
          <option value="system">System</option>
          <option value="rounded">Rounded</option>
        </select>
      </Row>

      <Row label="Alignment">
        <div className="flex gap-1">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a}
              onClick={() => set('align', a)}
              className={`stage-option ${settings.align === a ? 'active' : ''}`}>
              {a}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Mirror">
        <div className="flex gap-1">
          {(['none', 'h', 'v', 'both'] as Mirror[]).map((m) => (
            <button key={m}
              onClick={() => set('mirror', m)}
              className={`stage-option ${settings.mirror === m ? 'active' : ''}`}>
              {m}
            </button>
          ))}
        </div>
      </Row>

      <div className="grid grid-cols-2 gap-2">
        <Row label="Text">
          <input type="color" value={settings.textColor}
            onChange={(e) => set('textColor', e.target.value)} className="w-full h-8 bg-transparent" />
        </Row>
        <Row label="Background">
          <input type="color" value={settings.bgColor}
            onChange={(e) => set('bgColor', e.target.value)} className="w-full h-8 bg-transparent" />
        </Row>
      </div>

      <Row label="Reading cue">
        <div className="flex gap-1">
          {(['chevron', 'line', 'none'] as const).map((g) => (
            <button key={g}
              onClick={() => set('readingGuide', g)}
              className={`stage-option ${settings.readingGuide === g ? 'active' : ''}`}>
              {g}
            </button>
          ))}
        </div>
      </Row>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.edgeFade}
          onChange={(e) => set('edgeFade', e.target.checked)} />
        Edge fade
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.cameraMirror}
          onChange={(e) => set('cameraMirror', e.target.checked)} />
        Mirror camera preview (recording is unmirrored)
      </label>

      <div className="stage-settings-help">
        <p>Space: play/pause · R: restart · M: cycle mirror</p>
        <p>↑/↓: speed · ←/→: font size · Esc: exit</p>
      </div>
    </div>
  );
}

function RecordControls({ recorder }: { recorder: ReturnType<typeof useRecorder> }) {
  const s = recorder.state;
  if (s.kind === 'idle' || s.kind === 'error') {
    return (
      <button
        type="button"
        onClick={recorder.enable}
        className="stage-chip ghost"
        title="Enable camera + mic"
      >
        ◉ Cam
      </button>
    );
  }
  if (s.kind === 'requesting') {
    return <span className="stage-chip ghost">requesting…</span>;
  }
  if (s.kind === 'ready') {
    return (
      <>
        <button
          type="button"
          onClick={recorder.startCountdown}
          className="stage-chip record"
        >
          ● Rec
        </button>
        <button
          type="button"
          onClick={recorder.disable}
          className="stage-chip ghost"
          title="Turn off camera"
        >
          off
        </button>
      </>
    );
  }
  if (s.kind === 'countdown') {
    return (
      <button
        type="button"
        onClick={recorder.cancel}
        className="stage-chip ghost"
      >
        Cancel
      </button>
    );
  }
  if (s.kind === 'recording') {
    return (
      <button
        type="button"
        onClick={recorder.stopRecording}
        className="stage-chip record is-recording"
      >
        ■ Stop
      </button>
    );
  }
  return null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div
        className="text-[10px] uppercase tracking-[0.18em] text-white/55"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// --- voice-tracking helpers ---

export type Token = { word: string; idx: number };
export type VoicePhase = 'idle' | 'arming' | 'ready' | 'matching' | 'assist' | 'paused' | 'blocked';
export type VoiceMachineState = {
  phase: VoicePhase;
  cursor: number;
  armed: boolean;
};
export type VoiceMachineEvent =
  | { type: 'start_arming' }
  | { type: 'ready' }
  | { type: 'transcript_match'; cursor: number }
  | { type: 'speech_detected'; cursor: number }
  | { type: 'speech_ended' }
  | { type: 'blocked' }
  | { type: 'stop' };

export function reduceVoiceMachine(
  state: VoiceMachineState,
  event: VoiceMachineEvent
): VoiceMachineState {
  switch (event.type) {
    case 'start_arming':
      return { ...state, phase: 'arming', armed: false };
    case 'ready':
      return { ...state, phase: 'ready', armed: true };
    case 'transcript_match':
      if (!state.armed) return state;
      return { ...state, phase: 'matching', cursor: Math.max(state.cursor, event.cursor) };
    case 'speech_detected':
      if (!state.armed) return state;
      return { ...state, phase: 'assist', cursor: Math.max(state.cursor, event.cursor) };
    case 'speech_ended':
      return state.armed ? { ...state, phase: 'paused' } : state;
    case 'blocked':
      return { ...state, phase: 'blocked', armed: false };
    case 'stop':
      return { phase: 'idle', cursor: 0, armed: false };
  }
}

export function tokenizeWords(text: string): Token[] {
  const matches = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return matches.map((w, idx) => ({ word: w, idx }));
}

export function normalizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function renderVoiceText(text: string, cursor: number) {
  const parts = text.match(/[A-Za-z0-9']+|\s+|[^A-Za-z0-9'\s]+/g) ?? [];
  let tokenIndex = 0;

  return parts.map((part, index) => {
    if (!/[A-Za-z0-9']/.test(part)) return part;

    const currentToken = tokenIndex;
    tokenIndex += 1;

    if (currentToken < cursor) {
      return (
        <span key={`${part}-${index}`} className="voice-word-read">
          {part}
        </span>
      );
    }

    if (currentToken === cursor) {
      return (
        <span key={`${part}-${index}`} className="voice-word-current">
          {part}
        </span>
      );
    }

    return part;
  });
}

export function findVoiceMatchIndex(
  tokens: Token[],
  cursor: number,
  heard: string[]
): number {
  if (tokens.length === 0 || heard.length === 0) return -1;

  const searchStart = Math.max(0, cursor - 8);
  const searchEnd = Math.min(tokens.length, cursor + 90);
  const maxPhrase = Math.min(heard.length, 8);

  // Real SpeechRecognition often delivers a chunk after the user has already
  // read a whole sentence. Match the longest recent phrase first so the cursor
  // can catch up even when the first event arrives 20+ words into the script.
  for (let phraseLen = maxPhrase; phraseLen >= 2; phraseLen--) {
    const phrase = heard.slice(-phraseLen);
    for (let i = searchStart; i <= searchEnd - phraseLen; i++) {
      let matches = true;
      for (let j = 0; j < phraseLen; j++) {
        if (tokens[i + j].word !== phrase[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i + phraseLen - 1;
    }
  }

  const lastHeard = heard[heard.length - 1];
  const prevHeard = heard[heard.length - 2];
  for (let i = cursor; i < searchEnd; i++) {
    if (tokens[i].word !== lastHeard) continue;
    if (!prevHeard) return i;
    if (tokens.slice(Math.max(0, i - 6), i).some((t) => t.word === prevHeard)) {
      return i;
    }
  }

  return -1;
}

export function advanceVoiceAssistCursor(
  cursor: number,
  elapsedSec: number,
  speed: number,
  totalWords: number
): number {
  if (totalWords <= 0 || elapsedSec <= 0) return cursor;
  const wordsPerSec = Math.max(1.4, Math.min(3.4, speed / 32));
  return Math.min(totalWords - 1, cursor + wordsPerSec * elapsedSec);
}

export function readMicLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / data.length);
}

export function isVoiceLevelSpeaking(level: number): boolean {
  return level >= 0.035;
}

export function computeTimedScrollTop(
  elapsedSec: number,
  durationSec: number,
  maxScroll: number
): number {
  if (maxScroll <= 0 || durationSec <= 0 || elapsedSec <= 0) return 0;
  return Math.min(maxScroll, maxScroll * (elapsedSec / durationSec));
}

export function computeFixedScrollTop(
  currentTop: number,
  elapsedSec: number,
  pxPerSec: number,
  maxScroll: number
): number {
  if (maxScroll <= 0 || elapsedSec <= 0 || pxPerSec <= 0) return Math.max(0, currentTop);
  return Math.min(maxScroll, currentTop + pxPerSec * elapsedSec);
}

function scrollToToken(el: HTMLDivElement, token: Token) {
  // Proportional scroll: map cursor position to scroll position.
  // Total tokens count tracked via dataset on container for quick access.
  const total = parseInt(el.dataset.tokenCount ?? '0', 10);
  if (total <= 0) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  const target = (token.idx / total) * max;
  // Smooth seek; if we're behind target, ease forward, otherwise stay (don't scroll backward jaggedly)
  const current = el.scrollTop;
  if (target > current + 4) {
    el.scrollTo({ top: target, behavior: 'smooth' });
  } else if (target < current - 80) {
    // Significant backtrack (user re-read)
    el.scrollTo({ top: target, behavior: 'smooth' });
  }
}
