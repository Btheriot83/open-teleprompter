import { useCallback, useEffect, useRef, useState } from 'react';

export type RecordState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'ready'; stream: MediaStream }
  | { kind: 'countdown'; stream: MediaStream; secondsLeft: number }
  | { kind: 'recording'; stream: MediaStream; recorder: MediaRecorder; startedAt: number }
  | { kind: 'error'; message: string };

function pickMimeType(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return undefined;
}

export function useRecorder(opts: { onStartRecording: () => void; onStopRecording: () => void }) {
  const { onStartRecording, onStopRecording } = opts;
  const [state, setState] = useState<RecordState>({ kind: 'idle' });
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string | undefined>(undefined);
  const countdownTimerRef = useRef<number | null>(null);

  const enable = useCallback(async () => {
    setState({ kind: 'requesting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      setState({ kind: 'ready', stream });
    } catch (e: any) {
      setState({
        kind: 'error',
        message: e?.message ?? 'Could not access camera/microphone.',
      });
    }
  }, []);

  const disable = useCallback(() => {
    setState((s) => {
      if ('stream' in s) s.stream.getTracks().forEach((t) => t.stop());
      return { kind: 'idle' };
    });
  }, []);

  const startCountdown = useCallback(() => {
    setState((s) => {
      if (s.kind !== 'ready') return s;
      return { kind: 'countdown', stream: s.stream, secondsLeft: 3 };
    });
  }, []);

  const cancel = useCallback(() => {
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setState((s) => {
      if (s.kind === 'recording') {
        try {
          s.recorder.stop();
        } catch {}
      }
      if ('stream' in s) return { kind: 'ready', stream: s.stream };
      return s;
    });
  }, []);

  // Drive countdown → recording transition
  useEffect(() => {
    if (state.kind !== 'countdown') return;
    if (state.secondsLeft <= 0) {
      // Start recording
      const mime = pickMimeType();
      mimeRef.current = mime;
      chunksRef.current = [];
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
      } catch (e: any) {
        setState({ kind: 'error', message: e?.message ?? 'MediaRecorder failed to start.' });
        return;
      }
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: mimeRef.current ?? 'video/webm',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19);
        a.download = `teleprompter-${stamp}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        onStopRecording();
      };
      recorder.start(250); // 250ms timeslice for resilience
      onStartRecording();
      setState({
        kind: 'recording',
        stream: state.stream,
        recorder,
        startedAt: performance.now(),
      });
      return;
    }

    countdownTimerRef.current = window.setTimeout(() => {
      setState((s) =>
        s.kind === 'countdown' ? { ...s, secondsLeft: s.secondsLeft - 1 } : s
      );
    }, 1000);
    return () => {
      if (countdownTimerRef.current) window.clearTimeout(countdownTimerRef.current);
    };
  }, [state, onStartRecording, onStopRecording]);

  const stopRecording = useCallback(() => {
    setState((s) => {
      if (s.kind !== 'recording') return s;
      try {
        s.recorder.stop();
      } catch {}
      return { kind: 'ready', stream: s.stream };
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setState((s) => {
        if ('stream' in s) s.stream.getTracks().forEach((t) => t.stop());
        return s;
      });
    };
  }, []);

  return { state, enable, disable, startCountdown, cancel, stopRecording };
}
