// Thin wrapper over the git CLI. Every command that can carry a credential
// goes through run(), which scrubs secrets out of error messages.

import { execFileSync } from 'node:child_process';

export function createGit({ cwd, secrets = [] }) {
  const scrub = (text) => secrets.filter(Boolean).reduce((s, secret) => s.split(secret).join('[secure]'), String(text));

  function run(args, { allowFailure = false } = {}) {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
    } catch (error) {
      if (allowFailure) return null;
      const stderr = error.stderr ? String(error.stderr).trim() : '';
      throw new Error(scrub(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`));
    }
  }

  return {
    run,
    head: () => run(['rev-parse', 'HEAD']),
    currentBranch: () => run(['rev-parse', '--abbrev-ref', 'HEAD']),
    isShallow: () => run(['rev-parse', '--is-shallow-repository']) === 'true',
    remoteUrl: (remote = 'origin') => run(['remote', 'get-url', remote], { allowFailure: true }),
    fetchTags(remote, shallow) {
      if (shallow) run(['fetch', '--unshallow', '--tags', '--', remote]);
      else run(['fetch', '--tags', '--', remote]);
    },
    fetchNotes: (remote) => run(['fetch', '--', remote, '+refs/notes/*:refs/notes/*'], { allowFailure: true }),
    // Tags reachable from HEAD, like `git tag --merged <branch>`.
    mergedTags: () => run(['tag', '--merged', 'HEAD']).split('\n').map((t) => t.trim()).filter(Boolean),
    remoteBranchHead(remote, branch) {
      const out = run(['ls-remote', '--heads', '--', remote, branch]);
      return (out.match(/^(\w+)?/) || [])[1] || null;
    },
    verifyPush: (remote, branch) => run(['push', '--dry-run', '--no-verify', '--', remote, `HEAD:${branch}`], { allowFailure: true }) !== null,
    // Commits in (from, to], newest first: [{ hash, message }].
    log(from, to = 'HEAD') {
      const raw = run(['log', '--format=%H%x00%B%x00%x01', from ? `${from}..${to}` : to]);
      return raw.split('\x01').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((s) => {
        const [hash, message] = s.split('\x00');
        return { hash, message: (message ?? '').trim() };
      });
    },
    tagExists: (tag) => run(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true }) !== null,
    tag: (tag, ref = 'HEAD') => run(['tag', tag, ref]),
    deleteTag: (tag) => run(['tag', '-d', tag], { allowFailure: true }),
    remoteTagExists: (remote, tag) => run(['ls-remote', '--tags', '--', remote, `refs/tags/${tag}`]) !== '',
    pushTag: (remote, tag) => run(['push', '--', remote, `refs/tags/${tag}`]),
    // semantic-release records the release channel in a note per tag; written
    // the same way so the repo can switch back to semantic-release at any time.
    addNote: (tag) => run(['notes', '--ref', `semantic-release-${tag}`, 'add', '-f', '-m', JSON.stringify({ channels: [null] }), tag]),
    pushNote: (remote, tag) => run(['push', '--', remote, `refs/notes/semantic-release-${tag}`]),
    addWorktree: (dir, ref) => run(['worktree', 'add', '--detach', dir, ref]),
    removeWorktree: (dir) => run(['worktree', 'remove', '--force', dir], { allowFailure: true }),
  };
}
