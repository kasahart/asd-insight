'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acquirePlaybackGain,
  normalizePlaybackGain,
  type PlaybackGainStatus,
} from '@/lib/playback-gain';

export function usePlaybackGain(gainDb: number) {
  const gainRef = useRef(gainDb);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<{
    element: HTMLAudioElement;
    value: PlaybackGainStatus;
  } | null>(null);
  const leaseRef = useRef<ReturnType<typeof acquirePlaybackGain> | null>(null);
  const ref = useCallback((node: HTMLAudioElement | null) => {
    setElement(node);
  }, []);
  useEffect(() => {
    gainRef.current = normalizePlaybackGain(gainDb);
  }, [gainDb]);
  useEffect(() => {
    if (!element) return;
    const lease = acquirePlaybackGain(element, (value) => {
      setCurrent((previous) =>
        previous?.element === element &&
        previous.value.state === value.state &&
        previous.value.appliedDb === value.appliedDb &&
        previous.value.message === value.message
          ? previous
          : { element, value },
      );
    });
    leaseRef.current = lease;
    lease.setGain(gainRef.current);
    return () => {
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [element]);
  useEffect(() => {
    leaseRef.current?.setGain(gainDb);
  }, [element, gainDb]);
  const activate = useCallback((db = gainRef.current) => {
    gainRef.current = normalizePlaybackGain(db);
    leaseRef.current?.setGain(gainRef.current, true);
  }, []);
  return {
    ref,
    activate,
    status: current?.element === element ? current.value : null,
  };
}
