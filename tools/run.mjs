// Bundles a tools/*.ts script with esbuild and runs it in Node. Usage: node tools/run.mjs <name>
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = process.argv[2];
if (!name) throw new Error('usage: node tools/run.mjs <script name without .ts>');
const outfile = join(mkdtempSync(join(tmpdir(), 'murm-')), `${name}.mjs`);
await build({ entryPoints: [`tools/${name}.ts`], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning' });
await import(pathToFileURL(outfile).href);
