import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { hashUser } from './hooks.ts';
import { initStore, scopeOf, storeDir, withLock, writeFile } from './store.ts';

// one line per cwd on stdin → realpath, git root, origin, .agent-memory.json, user id (tab-separated)
const RESOLVE = String.raw`while IFS= read -r c; do (
  cd "$c" 2>/dev/null || { printf '\t\t\t\t%s\n' "$(id -un)"; exit; }
  r=$(git rev-parse --show-toplevel 2>/dev/null)
  printf '%s\t%s\t%s\t%s\t%s\n' "$(pwd -P)" "$r" "$(git remote get-url origin 2>/dev/null)" "$(cat "$r/.agent-memory.json" 2>/dev/null | tr -d '\n\t')" "$(git config user.email 2>/dev/null || id -un)"
); done`;

const ssh = (host: string, cmd: string, input = '') =>
  execFileSync(process.env.AGENT_MEMORY_SSH ?? 'ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const lines = (text: string) => text.split('\n').length - 1;

function cwdOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    try {
      const cwd = JSON.parse(line).cwd;
      if (cwd) return cwd;
    } catch {}
  }
}

function list(host: string, since: string): [string, string[]] {
  const filter = since ? `r=$(mktemp) && TZ=UTC touch -t '${since.replace(/[^\d.]/g, '')}' "$r" && ` : '';
  const newer = since ? ' -newer "$r"' : '';
  const out = ssh(host, `date -u +%Y%m%d%H%M.%S && cd ~/.claude/projects && ${filter}find . -maxdepth 2 -name '*.jsonl'${newer}; s=$?; rm -f "$r"; exit $s`);
  const [now, ...files] = out.toString().trim().split('\n');
  return [now, files.filter(Boolean)];
}

function pullHost(dir: string, host: string, since: string): [string, number] {
  const [now, files] = list(host, since);
  if (!files.length) return [now, 0];
  const tmp = mkdtempSync(join(tmpdir(), 'pull-'));
  try {
    execFileSync('tar', ['xf', '-', '-C', tmp], { input: ssh(host, 'cd ~/.claude/projects && tar cf - -T -', files.join('\n') + '\n') });
    const sessions = files.flatMap((f) => {
      const text = readFileSync(join(tmp, f), 'utf8');
      const cwd = cwdOf(text);
      return cwd ? [{ id: basename(f, '.jsonl'), text, cwd }] : [];
    });
    const cwds = [...new Set(sessions.map((s) => s.cwd))];
    const rows = ssh(host, RESOLVE, cwds.join('\n') + '\n').toString().split('\n');
    const info = new Map(
      cwds.map((cwd, i) => {
        const [real, root, remote, config, user] = (rows[i] ?? '').split('\t');
        const globs: string[] = config ? (JSON.parse(config).scopes ?? []) : [];
        return [cwd, { ...scopeOf(root || null, remote || null, globs, root ? relative(root, real) : ''), user: user ? hashUser(user) : 'unknown' }];
      }),
    );
    for (const { id, text, cwd } of sessions) {
      const meta = join(dir, 'inbox', `${id}.json`);
      const processed = join(dir, 'inbox/processed', `${id}.jsonl`);
      const offset = existsSync(meta)
        ? (JSON.parse(readFileSync(meta, 'utf8')).offset ?? 0)
        : existsSync(processed)
          ? lines(readFileSync(processed, 'utf8'))
          : 0;
      const { repo, scopes, user } = info.get(cwd)!;
      writeFile(join(dir, 'inbox', `${id}.jsonl`), text);
      writeFile(meta, JSON.stringify({ session_id: id, user, repo, scope: scopes.at(-1), scopes, cwd, host, offset }, null, 2));
    }
    return [now, sessions.length];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function pull(dir: string): void {
  const path = join(dir, 'remotes.json');
  const remotes: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!Object.keys(remotes).length) console.error(`[pull] no hosts in ${path}`);
  for (const [host, since] of Object.entries(remotes)) {
    console.error(`[pull] ${new Date().toTimeString().slice(0, 8)} ${host}…`);
    try {
      const [now, count] = pullHost(dir, host, since);
      remotes[host] = now;
      console.error(`[pull] ${host}: ${count} sessions`);
      writeFile(path, JSON.stringify(remotes, null, 2) + '\n');
    } catch (e) {
      const err = e as Error & { stderr?: Buffer };
      console.error(`[pull] ${host} failed: ${err.stderr?.toString().trim() || err.message.split('\n')[0]}`);
    }
  }
}

// dream lock: pull must not rewrite inbox files a running dream is condensing or moving
if (import.meta.main) {
  const dir = initStore(storeDir());
  try {
    withLock(dir, 'dream', () => pull(dir), 0);
  } catch (e) {
    if (!(e as Error).message.startsWith('lock busy')) throw e;
    console.log('locked: a dream is running');
    process.exitCode = 1;
  }
}
