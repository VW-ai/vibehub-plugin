import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Disposable, deterministic Git-only fixture; never inherits user Git configuration. */
export function temporaryGitRepository(format = 'sha1') {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-git-provenance-'));
  const repository_path = join(directory, 'repo'); mkdirSync(repository_path);
  const env = { PATH: process.env.PATH, HOME: directory, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_AUTHOR_DATE: '2025-01-02T03:04:05+0530', GIT_COMMITTER_DATE: '2025-01-03T04:05:06-0700' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-C', repository_path, ...args],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, text) => writeFileSync(join(repository_path, name), text);
  const commit = message => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '--initial-branch=main', `--object-format=${format}`, '--template=');
  return { directory, repository_path, git, write, commit, env, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function historyFixture(format = 'sha1') {
  const fixture = temporaryGitRepository(format); const { git, write, commit, repository_path } = fixture;
  write('a.txt', 'one\n'); write('delete.txt', 'delete me\n'); write('rename-old.txt', 'rename me\n');
  for (const name of ['-dash.txt', 'tab\tname.txt', 'line\nname.txt']) write(name, 'odd path\n');
  const root = commit('root');
  write('a.txt', 'two\n'); rmSync(join(repository_path, 'delete.txt'));
  renameSync(join(repository_path, 'rename-old.txt'), join(repository_path, 'rename-new.txt'));
  const advance = commit('advance');
  git('checkout', '-b', 'topic', root); write('topic.txt', 'topic\n'); const topic = commit('topic');
  git('checkout', 'main'); git('merge', '--no-ff', '-m', 'merge', topic); const merge = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'rewritten', root); write('feature.txt', 'feature\n'); const before_rebase = commit('feature');
  git('rebase', '--onto', merge, root); const after_rebase = git('rev-parse', 'HEAD');
  return { ...fixture, root, advance, topic, merge, before_rebase, after_rebase };
}
