import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, git, initStore, writeFile } from '../src/store.ts';

export function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'adm-')));
}

export function makeRepo(remote?: string, files: Record<string, string> = {}): string {
  const dir = tmp();
  git(dir, 'init', '-q');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  for (const [path, content] of Object.entries(files)) writeFile(join(dir, path), content);
  return dir;
}

export function makeStore(files: Record<string, string> = {}): string {
  const dir = initStore(join(tmp(), 'store'));
  for (const [path, content] of Object.entries(files)) writeFile(join(dir, path), content);
  commit(dir, 'fixture');
  return dir;
}

export const topics = (...entries: [string, string, string][]) =>
  '# Topics\n\n' + entries.map(([n, p, b]) => `## ${n}\nPurpose: ${p}\nBoundary: ${b}\n`).join('\n');

export const spec = (topic: string, description: string, ...reqs: [string, string][]) =>
  `---\ntopic: ${topic}\ndescription: ${description}\nupdated: 2026-10-16\n---\n\n` +
  reqs.map(([name, body]) => `### Requirement: ${name}\n${body}\n`).join('\n');
