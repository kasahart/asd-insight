import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
const prepared = new URL('../runtime/prepared/', import.meta.url);
await mkdir(prepared, { recursive: true });
await copyFile(
  new URL('../public/favicon.svg', import.meta.url),
  new URL('favicon.svg', prepared),
);
await copyFile(
  new URL('../deployment/app-config.json', import.meta.url),
  new URL('app-config.json', prepared),
);
const manual = new URL('../manual/', import.meta.url);
const preparedManual = new URL('manual/', prepared);
await rm(preparedManual, { recursive: true, force: true });
await cp(manual, preparedManual, { recursive: true, force: true });
