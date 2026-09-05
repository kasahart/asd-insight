import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Run the numerical reference cases against production compatibility entry
// points. The retired JavaScript waveform test is excluded; audio has its own
// Wandas worker suite. No prototype implementation is imported as a fallback.
const libraryURL = new URL('../../src/lib/', import.meta.url).href;
const temporary = await mkdtemp(join(tmpdir(), 'overlap-domain-reference-'));
try {
  for (const suite of [
    'core',
    'threshold',
    'precision-recall',
    'sample-review',
    'review-audit',
    'score-coverage',
    'distribution-viewport',
    'csv-diagnostics',
  ]) {
    let source = await readFile(
      new URL(`../${suite}.test.mjs`, import.meta.url),
      'utf8',
    );
    if (suite === 'core') {
      const parsed = ts.createSourceFile(
        'core.test.mjs',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      source = parsed.statements
        .filter((statement) => {
          if (
            ts.isImportDeclaration(statement) &&
            statement.moduleSpecifier.text === '../lib/audio.ts'
          )
            return false;
          return !(
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            statement.expression.arguments[0]?.text ===
              'demo WAV has a valid mono PCM header and bounded signal'
          );
        })
        .map((statement) => statement.getFullText(parsed))
        .join('');
    }
    const resolved = source.replaceAll("'../lib/", `'${libraryURL}`);
    const path = join(temporary, `${suite}.test.mjs`);
    await writeFile(path, resolved);
    await import(pathToFileURL(path).href);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
