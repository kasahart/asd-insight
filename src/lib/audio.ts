export function demoWave(seedValue: number, groupB: boolean, noisy: boolean) {
  const rate = 16000,
    length = rate * 4,
    samples = new Float32Array(length);
  let seed = seedValue + 1000;
  const frequency = 180 + (seedValue % 9) * 8;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const noise = ((seed >>> 0) / 4294967296) * 2 - 1,
      t = i / rate;
    const envelope = Math.min(1, t * 15, (4 - t) * 15);
    const pulse = groupB
      ? 0.1 *
        Math.sin(2 * Math.PI * 1450 * t) *
        Math.pow(Math.max(0, Math.sin(2 * Math.PI * 6 * t)), 12)
      : 0;
    samples[i] =
      envelope *
      (0.13 * Math.sin(2 * Math.PI * frequency * t) +
        0.04 * Math.sin(2 * Math.PI * frequency * 2 * t) +
        pulse +
        noise * (noisy ? 0.075 : 0.012));
  }
  return { samples, rate };
}
export function wavBuffer(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) =>
    view.setInt16(
      44 + i * 2,
      Math.round(Math.max(-1, Math.min(1, x)) * 32767),
      true,
    ),
  );
  return buffer;
}
