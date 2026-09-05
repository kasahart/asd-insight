import type { Dataset } from './demo';
import type { GroupSpec, Profile } from './data';
import { EvaluationWorkerClient } from '@domain/evaluation-client';

export type DatasetSetup = { idColumn: string; audioColumn: string; score: string; group: GroupSpec };
export type DatasetCandidate = { dataset: Dataset; profiles: Profile[]; setup: DatasetSetup; warning: string | null; source?: File };
export function initialSetup(data: Dataset, profiles: Profile[]): DatasetSetup {
  const idColumn = data.columns.find(c => /^(sample_id|sample_name|id|inspection_id|検査id|サンプル名)$/i.test(c)) ?? data.columns.find(c => /^(audio_file|audio_path|wav_path|file_path|filename|path)$/i.test(c)) ?? '';
  const audioColumn = data.columns.find(c => /^(audio_file|audio_path|wav_path|file_path|filename|audio|path)$/i.test(c)) ?? '';
  const numeric = profiles.filter(p => p.numeric && p.column !== idColumn && p.column !== audioColumn && p.values.length > 1);
  const score = (data.demo ? 'score_a' : numeric.find(p => /(score|異常|anomal)/i.test(p.column))?.column ?? numeric.find(p => !/^(is_|label|group|class|ground_truth)/i.test(p.column))?.column ?? numeric[0]?.column) ?? '';
  const eligible = profiles.filter(p => p.column !== score && p.column !== idColumn && p.column !== audioColumn && p.values.length >= 2 && (p.numeric || p.values.length <= 100));
  const p = eligible.find(p => /^(group|label|class|ground_truth|is_normal|is_anomaly|判定|群)$/i.test(p.column)) ?? eligible.find(p => !p.numeric) ?? eligible[0];
  const group: GroupSpec = p ? (p.values.length <= 100 ? { kind: 'category', column: p.column, a: p.values[0], b: p.values[1] } : { kind: 'numeric', column: p.column, upperA: 0, lowerB: 1 }) : { kind: 'category', column: '', a: '', b: '' };
  return { idColumn, audioColumn, score, group };
}
export function createDatasetCandidate(dataset: Dataset, profiles: Profile[], source?: File): DatasetCandidate {
  const setup = initialSetup(dataset, profiles);
  return { dataset, profiles, setup, warning: !setup.score || !setup.group.column ? '表示後に評価する異常度と比較群を選んでください。' : null, ...(source ? { source } : {}) };
}
export async function readCSVCandidate(files: readonly File[], signal: AbortSignal): Promise<DatasetCandidate> {
  signal.throwIfAborted();
  if (files.length !== 1) throw new Error('CSVまたはTSVを1ファイル選んでください。');
  const file = files[0];
  if (!/\.(csv|tsv)$/i.test(file.name)) throw new Error('CSVまたはTSV形式のファイルを選んでください。');
  if (file.size > 20 * 1024 ** 2) throw new Error('CSVは20MB・100,000行・128列までです。');
  const bytes = await file.arrayBuffer(); signal.throwIfAborted();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('UTF-8のCSVまたはTSVとして保存し直してください。'); }
  const client = new EvaluationWorkerClient();
  try { const prepared = await client.parseCSV(text, file.name, { signal }); return createDatasetCandidate(prepared.dataset, prepared.profiles, file); }
  finally { client.dispose(); }
}
export function initialWorkspaceState(candidate: DatasetCandidate): Record<string, unknown> {
  const { setup, dataset } = candidate;
  return { schemaVersion: 1, ...setup, rowCount: dataset.rows.length, numericA: setup.group.kind === 'numeric' ? String(setup.group.upperA) : '', numericB: setup.group.kind === 'numeric' ? String(setup.group.lowerB) : '', okGroup: 'A', direction: 'high', targetPercent: '1', queryMode: 'partial' };
}
