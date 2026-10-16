import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveScope } from '../src/store.ts';
import { makeRepo, tmp } from './helpers.ts';

describe('scope resolution', () => {
  it('should map repo cwd without config to repo scope from normalized remote', () => {
    const ssh = makeRepo('git@bitbucket.org:atlassian/foo.git');
    const https = makeRepo('https://github.com/acme/bar.git');
    const sshPort = makeRepo('ssh://git@stash.example.com:7999/team/baz.git');

    assert.deepEqual(resolveScope(ssh).scopes, ['org', 'repos/bitbucket.org/atlassian/foo']);
    assert.deepEqual(resolveScope(https).scopes, ['org', 'repos/github.com/acme/bar']);
    assert.deepEqual(resolveScope(sshPort).scopes, ['org', 'repos/stash.example.com/team/baz']);
  });

  it('should map cwd under configured subfolder glob to deepest subfolder scope', () => {
    const repo = makeRepo('git@github.com:acme/mono.git', {
      '.agent-memory.json': JSON.stringify({ scopes: ['packages/*', 'packages/ui/widgets'] }),
    });
    const deep = join(repo, 'packages/ui/widgets/src');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, 'packages/api/src'), { recursive: true });

    assert.deepEqual(resolveScope(deep), {
      repo: 'repos/github.com/acme/mono',
      scopes: ['org', 'repos/github.com/acme/mono', 'repos/github.com/acme/mono/packages/ui/widgets'],
    });
    assert.deepEqual(resolveScope(join(repo, 'packages/api/src')).scopes.at(-1), 'repos/github.com/acme/mono/packages/api');
    assert.deepEqual(resolveScope(repo).scopes.at(-1), 'repos/github.com/acme/mono');
  });

  it('should give non-git cwd org scope only', () => {
    assert.deepEqual(resolveScope(tmp()), { repo: null, scopes: ['org'] });
  });
});
