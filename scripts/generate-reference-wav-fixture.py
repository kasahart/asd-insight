#!/usr/bin/env python3
"""Generate synthetic-only, distinct 0.25-second PCM WAVs outside tracked files."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import struct
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--count', type=int, default=100001)
args = parser.parse_args()
if not 2 <= args.count <= 100001:
    parser.error('--count must be 2..100001')
if args.output.exists():
    parser.error('--output must not already exist (existing fixtures are never overwritten)')
started = time.monotonic()
args.output.mkdir(parents=True)
header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 4036, b'WAVE', b'fmt ', 16,
                     1, 1, 8000, 16000, 2, 16, b'data', 4000)
digests = set()
csv_path = args.output / f'synthetic-{args.count}.csv'
with csv_path.open('w', newline='', encoding='utf-8') as output:
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow(['id', 'audio_file', 'score', 'group', 'device'])
    for i in range(1, args.count + 1):
        sample = f'syn_{i:06d}'
        group = 'group_a' if i % 2 else 'group_b'
        device = f'device_{((i - 1) // 2) % 4 + 1:02d}'
        relative = f'{group}/{device}/{sample}.wav'
        path = args.output / 'wav' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        # Distinct deterministic synthetic PCM, with no real recordings or personal data.
        pcm = struct.pack('<I', i) + hashlib.shake_256(sample.encode()).digest(3996)
        content = header + pcm
        path.write_bytes(content)
        digests.add(hashlib.sha256(content).hexdigest())
        score = int.from_bytes(hashlib.sha256(sample.encode()).digest()[:4], 'little') / 2**32
        writer.writerow([sample, relative, f'{score:.6f}', group, device])
manifest = dict(kind='synthetic-only', count=args.count, sample_rate=8000, channels=1,
                sample_width_bytes=2, duration_seconds=0.25, bytes_per_wav=4044,
                wav_total_bytes=4044 * args.count, distinct_wav_sha256_count=len(digests),
                csv_columns=['id', 'audio_file', 'score', 'group', 'device'],
                csv_bytes=csv_path.stat().st_size,
                csv_sha256=hashlib.sha256(csv_path.read_bytes()).hexdigest(),
                generation_seconds=round(time.monotonic() - started, 3))
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
