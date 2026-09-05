export type DataRow = Record<string, string>;
export type Dataset = {
  name: string;
  columns: string[];
  rows: DataRow[];
  demo: boolean;
};
export function demoDataset(): Dataset {
  let seed = 8492;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-8))) *
    Math.cos(2 * Math.PI * random());
  const rows = Array.from({ length: 420 }, (_, i) => {
    const group = i < 260 ? 0 : 1,
      noisy = random() < 0.35,
      z = normal();
    return {
      sample_id: 'DEMO-' + String(i + 1).padStart(4, '0'),
      cohort: group ? '比較群' : '参照群',
      score_a: Math.max(
        0.015,
        0.36 + group * 0.25 + (noisy ? 0.18 : 0) + z * 0.145,
      ).toFixed(4),
      score_b: Math.max(
        0.008,
        0.25 + group * 0.42 + (noisy ? 0.06 : 0) + z * 0.1 + normal() * 0.03,
      ).toFixed(4),
      rating:
        i % 6 === 0
          ? String(
              Math.max(
                1,
                Math.min(5, Math.round(2 + group * 1.5 + normal() * 0.8)),
              ),
            )
          : '',
      condition: noisy ? '背景音あり' : '標準',
      batch: 'Lot-' + String.fromCharCode(65 + (i % 3)),
      audio_file: 'DEMO-' + String(i + 1).padStart(4, '0') + '.wav',
    };
  });
  return {
    name: 'demo_inspection.csv',
    columns: Object.keys(rows[0]),
    rows,
    demo: true,
  };
}
