export const MAX_PLAYBACK_GAIN_DB = 36;

export function normalizePlaybackGain(db: number): number {
  return Number.isFinite(db)
    ? Math.max(0, Math.min(MAX_PLAYBACK_GAIN_DB, Math.round(db)))
    : 0;
}

export function playbackGainFactor(db: number): number {
  return 10 ** (normalizePlaybackGain(db) / 20);
}

export type PlaybackGainStatus = {
  state: 'native' | 'waiting' | 'ready' | 'unavailable';
  appliedDb: number;
  message: string;
};

type GainGraph = {
  element: HTMLAudioElement;
  context: AudioContext | null;
  gain: GainNode | null;
  source: MediaElementAudioSourceNode | null;
  desiredDb: number;
  output: 'gain' | 'direct' | null;
  disposed: boolean;
  disposal: object | null;
  owners: Set<(status: PlaybackGainStatus) => void>;
  status: PlaybackGainStatus;
  createContext: () => AudioContext;
  onStateChange: (() => void) | null;
};

// A media element may only be captured once. React's development lifecycle can
// release and immediately reacquire that same DOM element without replacing it.
const graphs = new WeakMap<HTMLAudioElement, GainGraph>();

function audioContext(): AudioContext {
  const Constructor =
    globalThis.AudioContext ??
    (
      globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!Constructor) throw new Error('Web Audio is unavailable');
  return new Constructor();
}

function status(
  graph: GainGraph,
  state: PlaybackGainStatus['state'],
  appliedDb: number,
  message = '',
) {
  graph.status = { state, appliedDb, message };
  for (const owner of graph.owners) owner(graph.status);
}

function disconnect(node: AudioNode | null) {
  try {
    node?.disconnect();
  } catch {
    // Already-disconnected nodes do not prevent the remaining cleanup.
  }
}

function close(context: AudioContext | null) {
  try {
    if (context && context.state !== 'closed')
      void context.close().catch(() => {});
  } catch {
    // Native playback was never captured for initialization failures.
  }
}

function fail(graph: GainGraph) {
  if (graph.disposed) return;
  status(
    graph,
    'unavailable',
    graph.output ? graph.status.appliedDb : 0,
    graph.source
      ? '増幅の再開に失敗しました。再生ボタンかゲイン操作で再試行してください。'
      : '増幅は未適用です。通常の音量で再生できます。再生ボタンかゲイン操作で再試行してください。',
  );
}

function applyGain(graph: GainGraph) {
  const { context, gain, source } = graph;
  if (!context || !gain || !source || graph.disposed) return;
  if (context.state !== 'running') {
    status(
      graph,
      'waiting',
      graph.status.appliedDb,
      '増幅の再開待ちです。再生ボタンかゲイン操作で再試行してください。',
    );
    return;
  }
  if (!graph.output) {
    try {
      source.connect(gain);
      graph.output = 'gain';
    } catch {
      try {
        source.connect(context.destination);
        graph.output = 'direct';
      } catch {
        fail(graph);
        return;
      }
    }
  }
  if (graph.output === 'direct') {
    status(
      graph,
      graph.desiredDb === 0 ? 'ready' : 'unavailable',
      0,
      graph.desiredDb === 0
        ? ''
        : '増幅を使えないため、通常の音量で再生します。',
    );
    return;
  }
  try {
    const now = context.currentTime;
    if (typeof gain.gain.cancelAndHoldAtTime === 'function')
      gain.gain.cancelAndHoldAtTime(now);
    else {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
    }
    // Smooth the transition to avoid a click; do not rewrite the source PCM.
    gain.gain.setTargetAtTime(playbackGainFactor(graph.desiredDb), now, 0.015);
    status(graph, 'ready', graph.desiredDb);
  } catch {
    // Once captured, the element cannot return to its native output route.
    // Keep an audible direct route if gain automation is unsupported or fails.
    try {
      disconnect(source);
      graph.output = null;
      source.connect(context.destination);
      graph.output = 'direct';
      status(
        graph,
        'unavailable',
        0,
        '増幅を使えないため、通常の音量で再生します。',
      );
    } catch {
      fail(graph);
    }
  }
}

async function activate(graph: GainGraph) {
  if (graph.disposed || !graph.owners.size) return;
  if (graph.desiredDb === 0 && !graph.source) {
    status(graph, 'native', 0);
    return;
  }
  try {
    if (!graph.context) {
      graph.context = graph.createContext();
      graph.onStateChange = () => {
        if (graph.disposed || !graph.source) return;
        if (graph.context?.state === 'running') applyGain(graph);
        else
          status(
            graph,
            'waiting',
            graph.status.appliedDb,
            '増幅の再開待ちです。再生ボタンかゲイン操作で再試行してください。',
          );
      };
      graph.context.addEventListener('statechange', graph.onStateChange);
    }
    const context = graph.context;
    // Prepare everything reversible before capturing the native media element.
    if (!graph.gain) {
      const gain = context.createGain();
      gain.connect(context.destination);
      graph.gain = gain;
    }
    if (context.state !== 'running') {
      status(graph, 'waiting', 0, '再生ゲインの開始待ちです。');
      // Called in play/pointer/key/slider handlers, not automatically on mount.
      await context.resume();
    }
    if (graph.disposed || !graph.owners.size) return;
    if (context.state !== 'running')
      throw new Error('Audio context is not running');
    if (!graph.source && graph.desiredDb === 0) {
      status(graph, 'native', 0);
      return;
    }
    if (!graph.source) {
      graph.source = context.createMediaElementSource(graph.element);
    }
    applyGain(graph);
  } catch {
    fail(graph);
  }
}

export function acquirePlaybackGain(
  element: HTMLAudioElement,
  onStatus: (status: PlaybackGainStatus) => void,
  createContext: () => AudioContext = audioContext,
) {
  let graph = graphs.get(element);
  if (!graph) {
    graph = {
      element,
      context: null,
      gain: null,
      source: null,
      desiredDb: 0,
      output: null,
      disposed: false,
      disposal: null,
      owners: new Set(),
      status: { state: 'native', appliedDb: 0, message: '' },
      createContext,
      onStateChange: null,
    };
    graphs.set(element, graph);
  }
  const active = graph;
  active.disposal = null;
  active.owners.add(onStatus);
  onStatus(active.status);
  let released = false;
  return {
    setGain(db: number, userGesture = false) {
      if (released || active.disposed) return;
      const previousDb = active.desiredDb;
      active.desiredDb = normalizePlaybackGain(db);
      // A React preference update follows the gesture in the same turn. It
      // must not hide a failure just reported by that gesture's activation.
      if (
        !userGesture &&
        active.desiredDb === previousDb &&
        active.status.state === 'unavailable'
      )
        return;
      if (active.source) applyGain(active);
      else
        status(
          active,
          active.desiredDb === 0 ? 'native' : 'waiting',
          0,
          active.desiredDb === 0 ? '' : '再生時に適用',
        );
      if (userGesture) void activate(active);
    },
    release() {
      if (released) return;
      released = true;
      active.owners.delete(onStatus);
      if (active.owners.size) return;
      const disposal = {};
      active.disposal = disposal;
      // StrictMode setup follows cleanup in the same task and cancels disposal.
      queueMicrotask(() => {
        if (active.disposal !== disposal || active.owners.size) return;
        active.disposed = true;
        if (active.context && active.onStateChange)
          active.context.removeEventListener(
            'statechange',
            active.onStateChange,
          );
        disconnect(active.source);
        disconnect(active.gain);
        close(active.context);
        // Keep captured elements registered even after close: capturing again
        // would throw. A true component remount receives a new audio element.
        if (!active.source) graphs.delete(element);
        else
          active.status = {
            state: 'unavailable',
            appliedDb: 0,
            message:
              '音声の再生経路は終了しています。別のサンプルを選んでから戻してください。',
          };
      });
    },
  };
}
