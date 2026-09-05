import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { WorkspaceController } from './workspace-controller';

export type DeploymentPolicy = { persistentStorage: boolean; downloads: boolean; maxBundleMiB: number; maxTotalMiB: number };
export const WorkspaceContext = createContext<{ controller: WorkspaceController; policy: DeploymentPolicy; openManager: () => void } | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('分析を開いてください。');
  const snapshot = useSyncExternalStore(value.controller.subscribe, value.controller.getSnapshot);
  return { ...value, ...snapshot };
}
/** Declarative edits are durable; derived arrays, files, errors and transient drags are not state fields. */
export function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [local, setLocal] = useState<T>(initial);
  const value = useContext(WorkspaceContext);
  const controller = value?.controller;
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? noSnapshot);
  const state = snapshot?.active?.record.state;
  const current = (state && Object.hasOwn(state, key) ? state[key] : local) as T;
  const update = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    controller?.setState(key, next as unknown, local);
  }, [controller, key, local]);
  return controller ? [current, update] : [local, setLocal];
}
const noSubscribe = () => () => {};
const noSnapshot = () => null;
