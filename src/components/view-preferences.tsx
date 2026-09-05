'use client';
import { useSessionState } from '@/state/workspace-context';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type DetailsHTMLAttributes,
  type ReactNode,
} from 'react';

type AudioPreferences = {
  volume: number;
  muted: boolean;
  playbackRate: number;
  gainDb: number;
};
export type SpectrogramRange = { min: number; max: number };
export type SpectrogramRangePreference = {
  range: SpectrogramRange | null;
  minInput: string;
  maxInput: string;
  // Distinguishes untouched Auto from an intentional, even fully empty draft.
  draftStarted?: boolean;
};
// Time is seconds, frequency is kHz, color is dBFS. Null means the default
// scale; drafts belong here too so switching samples never erases an edit.
export type SpectrogramPreferences = {
  time: SpectrogramRangePreference;
  frequency: SpectrogramRangePreference;
  color: SpectrogramRangePreference;
};
type ViewPreferences = {
  disclosures: Record<string, boolean>;
  setDisclosure: (key: string, open: boolean) => void;
  audio: AudioPreferences;
  updateAudio: (patch: Partial<AudioPreferences>) => void;
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
  spectrogram: SpectrogramPreferences;
  updateSpectrogram: (patch: Partial<SpectrogramPreferences>) => void;
};
const ViewPreferencesContext = createContext<ViewPreferences | null>(null);

// Session-level presentation choices belong above data-dependent/keyed views.
// Do not put sample content, playback position, or evaluation results here.
export function ViewPreferencesProvider({ children }: { children: ReactNode }) {
  const [disclosures, setDisclosures] = useSessionState<
    Record<string, boolean>
  >('disclosures', {});
  const [audio, setAudio] = useSessionState<AudioPreferences>(
    'audioPreferences',
    {
      volume: 0.35,
      muted: false,
      playbackRate: 1,
      gainDb: 0,
    },
  );
  const [inspectorWidth, storeInspectorWidth] = useSessionState(
    'inspectorWidth',
    320,
  );
  const [spectrogram, setSpectrogram] = useSessionState<SpectrogramPreferences>(
    'spectrogramPreferences',
    {
      time: { range: null, minInput: '', maxInput: '' },
      frequency: { range: null, minInput: '', maxInput: '' },
      color: { range: null, minInput: '', maxInput: '' },
    },
  );
  const setDisclosure = useCallback(
    (key: string, open: boolean) => {
      setDisclosures((previous) =>
        previous[key] === open ? previous : { ...previous, [key]: open },
      );
    },
    [setDisclosures],
  );
  const updateAudio = useCallback(
    (patch: Partial<AudioPreferences>) => {
      setAudio((previous) => {
        const next = { ...previous, ...patch };
        return next.volume === previous.volume &&
          next.muted === previous.muted &&
          next.playbackRate === previous.playbackRate &&
          next.gainDb === previous.gainDb
          ? previous
          : next;
      });
    },
    [setAudio],
  );
  const setInspectorWidth = useCallback(
    (width: number) => {
      if (Number.isFinite(width) && width > 0) storeInspectorWidth(width);
    },
    [storeInspectorWidth],
  );
  const updateSpectrogram = useCallback(
    (patch: Partial<SpectrogramPreferences>) => {
      setSpectrogram((previous) => ({ ...previous, ...patch }));
    },
    [setSpectrogram],
  );
  const value = useMemo(
    () => ({
      disclosures,
      setDisclosure,
      audio,
      updateAudio,
      inspectorWidth,
      setInspectorWidth,
      spectrogram,
      updateSpectrogram,
    }),
    [
      disclosures,
      setDisclosure,
      audio,
      updateAudio,
      inspectorWidth,
      setInspectorWidth,
      spectrogram,
      updateSpectrogram,
    ],
  );
  return (
    <ViewPreferencesContext.Provider value={value}>
      {children}
    </ViewPreferencesContext.Provider>
  );
}

export function useViewPreferences() {
  const value = useContext(ViewPreferencesContext);
  if (!value) throw new Error('表示設定の保持領域がありません。');
  return value;
}

type PersistentDetailsProps = Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  'open' | 'onToggle' | 'name'
> & {
  // A section's identity, never a sample ID, row index, or dataset name.
  preferenceKey: string;
  defaultOpen?: boolean;
};

export function PersistentDetails({
  preferenceKey,
  defaultOpen = false,
  children,
  ...props
}: PersistentDetailsProps) {
  const { disclosures, setDisclosure } = useViewPreferences();
  const open = disclosures[preferenceKey] ?? defaultOpen;
  return (
    <details
      {...props}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        // Restoring `open` also emits toggle. Only a change from the rendered
        // state is a user's choice; explicit false must beat future defaults.
        if (nextOpen !== open) setDisclosure(preferenceKey, nextOpen);
      }}
    >
      {children}
    </details>
  );
}
