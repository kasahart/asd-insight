/** Offline Pyodide contract probes, separate from the application's fixed API. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'runtime/prepared/runtime/audio');
const lock = JSON.parse(await readFile(join(root, 'runtime/lock.json'), 'utf8'));
globalThis.fetch = async () => { throw new Error('Network disabled'); };
const { loadPyodide } = await import(pathToFileURL(join(directory, 'pyodide.mjs')));
const py = await loadPyodide({ indexURL: directory + '/', packageBaseUrl: directory + '/', lockFileContents: JSON.parse(await readFile(join(directory, 'pyodide-lock.json'), 'utf8')), stdout: () => {}, stderr: () => {} });
await py.loadPackage(lock.nativePackages);
const purelib = py.runPython('import sysconfig; sysconfig.get_path("purelib")');
for (const name of lock.pureWheels) {
  const bytes = await readFile(join(directory, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), lock.assets.find(a => a.path === name).sha256);
  py.unpackArchive(Uint8Array.from(bytes), 'zip', { extractDir: purelib });
}
py.FS.writeFile('/home/pyodide/wandas_adapter.py', await readFile(join(root, 'python/wandas_adapter.py')));
py.runPython(await readFile(join(root, 'tests/production/adapter-laziness.py'), 'utf8'));
console.log('PASS single header inspection, one PCM decode, zero PCM before guards, recovery');
py.runPython(String.raw`
import os, tempfile
from pathlib import Path
import pandas as pd
import wandas as wd
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    (root / 'a').mkdir(); (root / 'b').mkdir()
    sf.write(root/'a/same.wav', np.zeros(100), 8000)
    sf.write(root/'b/same.wav', np.ones(100)*0.25, 8000)
    (root/'catalog.csv').write_text('audio,trial,group\nb/same.wav,001,B\na/same.wav,002,A\nb/same.wav,003,C\n')
    with patch.object(Path, 'glob', side_effect=AssertionError('scan')), patch.object(SoundFileReader, 'get_file_info', wraps=SoundFileReader.get_file_info) as headers, patch.object(SoundFileReader, 'get_data', wraps=SoundFileReader.get_data) as pcm:
        files = wd.from_files(['b/same.wav','a/same.wav','b/same.wav'], base_dir=root)
        ds = wd.from_table(root/'catalog.csv', path_column='audio')
        df = pd.DataFrame({'audio':['a/same.wav','a/same.wav'], 'trial':['001','002'], 'score':[0.1,0.2], 'missing':[pd.NA,pd.NA]})
        typed = wd.from_table(df, path_column='audio', base_dir=root)
        df.loc[1, 'trial'] = 'changed'
        assert len(files)==len(ds)==3 and len(typed)==2
        selected = ds.select(group='C').trim(0,0.005)
        assert headers.call_count == pcm.call_count == 0
        previous = os.getcwd()
        try:
            os.chdir('/')
            assert files[0].to_numpy()[0] == 0.25
            assert files[1].to_numpy()[0] == 0
            assert files[2].to_numpy()[0] == 0.25
            f = selected[0]
            assert f.metadata['trial']=='003' and f.metadata['group']=='C'
            before = pcm.call_count
            assert f.to_numpy().shape == (40,) and pcm.call_count == before+1
            assert typed[1].metadata['trial']=='002' and typed[1].metadata['missing'] is None
            assert ds[0].metadata['trial']=='001' and ds[1].metadata['trial']=='002' and ds[2].metadata['trial']=='003'
            missing=wd.from_files(['missing.wav'],base_dir=root)
            assert len(missing)==1 and missing[0] is None
            (root/'broken.wav').write_bytes(b'bad')
            assert wd.from_files(['broken.wav'],base_dir=root)[0] is None
        finally:
            os.chdir(previous)
`);
console.log('PASS catalog/files ordering, duplicates, relative base after cwd change, string IDs, typed/missing metadata, snapshot, trim, broken/missing audio; small MEMFS only');
