'use client';
import { NativeSelect } from '@/components/ui/native-select';
import { useThreshold } from '@/components/threshold-context';
import type { ScoreDirection } from '@/lib/threshold';

export function EvaluationSettings({
  labelA,
  labelB,
}: {
  labelA: string;
  labelB: string;
}) {
  const { okGroup, direction, setOkGroup, setDirection } = useThreshold();
  return (
    <div className="evaluation-settings">
      <div className="field">
        <label htmlFor="evaluation-ok-group">OKとして扱う基準群</label>
        <NativeSelect
          id="evaluation-ok-group"
          value={okGroup}
          onChange={(event) => setOkGroup(event.target.value as 'A' | 'B')}
        >
          <option value="A">群A：{labelA}</option>
          <option value="B">群B：{labelB}</option>
        </NativeSelect>
      </div>
      <div className="field">
        <label htmlFor="evaluation-direction">NG候補とする方向</label>
        <NativeSelect
          id="evaluation-direction"
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as ScoreDirection)
          }
        >
          <option value="high">スコアが高い側</option>
          <option value="low">スコアが低い側</option>
        </NativeSelect>
      </div>
    </div>
  );
}
