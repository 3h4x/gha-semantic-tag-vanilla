// End to end: a real git repository with a bare "origin", a fake GitHub REST
// API on node:http and a recording fake npm CLI.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { createGit } from '../src/git.mjs';
import { createGitHub } from '../src/github.mjs';
import { createNpm } from '../src/npm.mjs';
import { run } from '../src/run.mjs';

// --- fake GitHub ------------------------------------------------------------
let api;
let apiUrl;
let server;
function resetApi() {
  api = { releases: new Map(), issues: new Map(), comments: [], labels: [], commitPulls: new Map(), pulls: new Map(), nextIssue: 100, calls: [] };
}

before(async () => {
  resetApi();
  server = createServer((req, res) => handle(req, res).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `fake API crashed: ${error.stack}` }));
  }));
  async function handle(req, res) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/repos\/o\/r/, '');
    api.calls.push(`${req.method} ${path}`);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    let m;
    if (req.method === 'GET' && (m = /^\/releases\/tags\/(.+)$/.exec(path))) {
      const rel = api.releases.get(decodeURIComponent(m[1]));
      return rel ? send(200, rel) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && path === '/releases') {
      const rel = { ...json, id: api.releases.size + 1, html_url: `https://github.com/o/r/releases/tag/${json.tag_name}` };
      api.releases.set(json.tag_name, rel);
      return send(201, rel);
    }
    if (req.method === 'GET' && (m = /^\/commits\/(\w+)\/pulls$/.exec(path))) return send(200, api.commitPulls.get(m[1]) || []);
    if (req.method === 'GET' && (m = /^\/pulls\/(\d+)\/commits$/.exec(path))) return send(200, (api.pulls.get(Number(m[1]))?.commits || []).map((sha) => ({ sha })));
    if (req.method === 'GET' && (m = /^\/pulls\/(\d+)$/.exec(path))) return send(200, api.pulls.get(Number(m[1])));
    if (req.method === 'GET' && path === '/issues') {
      const label = url.searchParams.get('labels');
      return send(200, [...api.issues.values()].filter((i) => i.state === 'open' && i.labels.some((l) => l.name === label)));
    }
    if (req.method === 'GET' && (m = /^\/issues\/(\d+)$/.exec(path))) {
      const issue = api.issues.get(Number(m[1]));
      return issue ? send(200, issue) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
      api.comments.push({ number: Number(m[1]), body: json.body });
      return send(201, { html_url: `https://github.com/o/r/issues/${m[1]}#c` });
    }
    if (req.method === 'POST' && (m = /^\/issues\/(\d+)\/labels$/.exec(path))) {
      api.labels.push({ number: Number(m[1]), labels: json.labels });
      return send(200, []);
    }
    if (req.method === 'PATCH' && (m = /^\/issues\/(\d+)$/.exec(path))) {
      const issue = api.issues.get(Number(m[1]));
      Object.assign(issue, json);
      return send(200, issue);
    }
    if (req.method === 'POST' && path === '/issues') {
      const number = api.nextIssue++;
      const issue = { number, ...json, state: 'open', labels: json.labels.map((name) => ({ name })), html_url: `https://github.com/o/r/issues/${number}` };
      api.issues.set(number, issue);
      return send(201, issue);
    }
    return send(500, { message: `unhandled ${req.method} ${path}` });
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// --- repository --------------------------------------------------------------
let work;
let remote;
const g = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Like a fresh runner: no global git config, so no identity.
const emptyConfig = join(mkdtempSync(join(tmpdir(), 'gstv-home-')), 'gitconfig');
writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gr = (...args) => execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(message) {
  writeFileSync(join(work, 'file.txt'), `${Math.random()}\n`);
  g('add', '-A');
  g('commit', '-q', '-m', message);
  g('push', '-q', 'origin', 'HEAD:main');
  return g('rev-parse', 'HEAD');
}
function setup(releaserc, pkg) {
  const root = mkdtempSync(join(tmpdir(), 'gstv-e2e-'));
  remote = join(root, 'remote.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  g('config', 'commit.gpgsign', 'false');
  g('config', 'tag.gpgsign', 'false');
  g('checkout', '-q', '-b', 'main');
  // origin is a local path here; in Actions it is the https URL.
  writeFileSync(join(work, '.releaserc'), JSON.stringify({ repositoryUrl: 'https://github.com/o/r', ...releaserc }));
  if (pkg) writeFileSync(join(work, 'package.json'), JSON.stringify(pkg, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: init');
  g('push', '-q', 'origin', 'main');
}

const GITHUB_ONLY = { branches: ['main'], plugins: ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/github'] };

let logs;
let npmCalls;
async function release({ dryRun = false, env = {}, npmExec } = {}) {
  logs = [];
  const fullEnv = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: apiUrl, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', ...env };
  const exec = npmExec || ((cmd, args, opts) => { npmCalls.push({ args, cwd: opts.cwd }); return ''; });
  return run({
    cwd: work,
    env: fullEnv,
    dryRun,
    git: createGit({ cwd: work, secrets: ['tok'] }),
    createGitHub: (o) => createGitHub({ ...o, retryDelayMs: 1 }),
    npm: createNpm({ dir: work, env: fullEnv, log: (m) => logs.push(m), exec }),
    log: (m) => logs.push(m),
    warn: (m) => logs.push(`WARN ${m}`),
    now: () => new Date('2026-10-12T12:00:00Z'),
  });
}

beforeEach(() => { resetApi(); npmCalls = []; });

test('first release, then patch with PR and issue comments, then nothing to release', async () => {
  setup(GITHUB_ONLY);
  commit('feat: first feature');
  let result = await release();
  assert.equal(result.published, true);
  assert.equal(result.version, '1.0.0');
  assert.equal(gr('tag'), 'v1.0.0');
  assert.match(gr('for-each-ref', 'refs/notes/'), /refs\/notes\/semantic-release-v1\.0\.0/);
  assert.equal(gr('log', '-1', '--format=%an <%ae>', 'refs/notes/semantic-release-v1.0.0'), 'semantic-release-bot <semantic-release-bot@martynus.net>');
  const r1 = api.releases.get('v1.0.0');
  assert.equal(r1.name, 'v1.0.0');
  assert.equal(r1.target_commitish, 'main');
  assert.equal(r1.make_latest, 'true');
  assert.equal(r1.body.split('\n')[0], '# 1.0.0 (2026-10-12)');

  const sha = commit('fix: a bug\n\nCloses #3');
  api.commitPulls.set(sha, [{ number: 4, body: 'Fixes #5' }]);
  api.pulls.set(4, { number: 4, commits: [sha], merge_commit_sha: 'zzz' });
  api.issues.set(3, { number: 3, state: 'open', labels: [] });
  api.issues.set(5, { number: 5, state: 'open', labels: [] });
  result = await release();
  assert.equal(result.version, '1.0.1');
  assert.equal(result.lastRelease.gitTag, 'v1.0.0');
  assert.match(api.releases.get('v1.0.1').body, /^## \[1\.0\.1\]\(https:\/\/github\.com\/o\/r\/compare\/v1\.0\.0\.\.\.v1\.0\.1\) \(2026-10-12\)/);
  assert.deepEqual(api.comments.map((c) => c.number).sort(), [3, 4, 5]);
  assert.match(api.comments.find((c) => c.number === 4).body, /This PR is included in version 1\.0\.1/);
  assert.match(api.comments.find((c) => c.number === 3).body, /This issue has been resolved in version 1\.0\.1/);
  assert.deepEqual(api.labels.map((l) => l.labels), [['released'], ['released'], ['released']]);

  commit('docs: only docs');
  result = await release();
  assert.equal(result.published, false);
  assert.equal(result.releaseType, undefined);
  assert.equal(gr('tag').split('\n').length, 2);
});

test('custom releaseRules make docs releasable; dry-run changes nothing', async () => {
  setup({ branches: ['main'], plugins: [['@semantic-release/commit-analyzer', { releaseRules: [{ type: 'docs', release: 'patch' }] }], '@semantic-release/release-notes-generator', '@semantic-release/github'] });
  commit('docs: readme');
  const result = await release({ dryRun: true });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.published, false);
  assert.equal(gr('tag'), '');
  assert.equal(api.releases.size, 0);
  assert.ok(!api.calls.some((c) => c.startsWith('POST')));
});

test('skips pull_request events, other branches and a branch behind its remote', async () => {
  setup(GITHUB_ONLY);
  commit('feat: x');
  assert.equal((await release({ env: { GITHUB_EVENT_NAME: 'pull_request' } })).published, false);
  assert.equal((await release({ env: { GITHUB_REF: 'refs/heads/feature' } })).published, false);
  assert.match(logs.join('\n'), /configured to only publish from main/);
  // someone pushed after this checkout
  const other = mkdtempSync(join(tmpdir(), 'gstv-other-'));
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' });
  execFileSync('git', ['-C', other, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'fix: elsewhere']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main']);
  assert.equal((await release()).published, false);
  assert.match(logs.join('\n'), /behind the remote one/);
  assert.equal(gr('tag'), '');
});

test('npm: version bump before tag, publish before the GitHub release', async () => {
  setup(
    { branches: ['main'], plugins: ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/npm', '@semantic-release/github'] },
    { name: '@o/r', version: '0.0.0-development', publishConfig: { registry: 'https://npm.pkg.github.com' } },
  );
  commit('feat: publish me');
  const order = [];
  const result = await release({
    env: { NPM_TOKEN: 'npmtok' },
    npmExec: (cmd, args, opts) => {
      npmCalls.push({ args, cwd: opts.cwd });
      order.push(`npm ${args[0]}`);
      if (args[0] === 'version') {
        const pkg = JSON.parse(readFileSync(join(opts.cwd, 'package.json'), 'utf8'));
        writeFileSync(join(opts.cwd, 'package.json'), JSON.stringify({ ...pkg, version: args[1] }));
      }
      if (args[0] === 'publish') order.push(`releases=${api.releases.size}`);
      return '';
    },
  });
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(order, ['npm version', 'npm publish', 'releases=0']);
  const publish = npmCalls.find((c) => c.args[0] === 'publish').args;
  assert.deepEqual(publish.slice(2), ['--userconfig', publish[3], '--tag', 'latest', '--registry', 'https://npm.pkg.github.com']);
  assert.match(readFileSync(publish[3], 'utf8'), /^\/\/npm\.pkg\.github\.com\/:_authToken = \$\{NPM_TOKEN\}$/);
  assert.equal(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version, '1.0.0');
  assert.equal(g('status', '--porcelain'), 'M package.json', 'version bump is not committed');
  assert.ok(api.releases.has('v1.0.0'));
});

test('npm: missing token fails before anything is tagged', async () => {
  setup(
    { branches: ['main'], plugins: ['@semantic-release/commit-analyzer', '@semantic-release/npm', ['@semantic-release/github', { failCommentCondition: '<% return false; %>' }]] },
    { name: 'pkg', version: '0.0.0' },
  );
  commit('feat: x');
  await assert.rejects(release(), { code: 'ENONPMTOKEN' });
  assert.equal(gr('tag'), '');
  assert.equal(api.issues.size, 0, 'failCommentCondition false: no failure issue');
});

test('recovers a tag that was pushed but never released', async () => {
  setup(GITHUB_ONLY);
  commit('feat: one');
  await release();
  commit('fix: two');
  // a previous run died right after pushing its tag
  g('tag', 'v1.0.1');
  g('push', '-q', 'origin', 'v1.0.1');
  commit('feat: three');
  const result = await release();
  assert.equal(result.recovered, 'v1.0.1');
  assert.match(api.releases.get('v1.0.1').body, /compare\/v1\.0\.0\.\.\.v1\.0\.1\).*\n\n\n### Bug Fixes\n\n\* two/);
  assert.equal(result.version, '1.1.0');
  assert.match(api.releases.get('v1.1.0').body, /compare\/v1\.0\.1\.\.\.v1\.1\.0/);
  assert.doesNotMatch(api.releases.get('v1.1.0').body, /two/);
});

test('failure opens an issue, a second failure comments on it, success closes it', async () => {
  setup(GITHUB_ONLY);
  commit('feat: x');
  // reject every push to the remote
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  await assert.rejects(release(), /git push/);
  const [issue] = [...api.issues.values()];
  assert.equal(issue.title, 'The automated release is failing 🚨');
  assert.deepEqual(issue.labels.map((l) => l.name), ['semantic-release']);
  assert.match(issue.body, /<!-- semantic-release:github -->$/);
  assert.ok(!logs.join('\n').includes('tok@'), 'token never logged');

  await assert.rejects(release());
  assert.equal(api.issues.size, 1);
  assert.equal(api.comments.filter((c) => c.number === issue.number).length, 1);

  execFileSync('rm', [hook]);
  const result = await release();
  assert.equal(result.published, true);
  assert.equal(api.issues.get(issue.number).state, 'closed');
});

test('unsupported config fails without touching anything', async () => {
  setup({ branches: ['main'], plugins: ['@semantic-release/commit-analyzer', '@semantic-release/git'] });
  commit('feat: x');
  await assert.rejects(release(), /Unsupported configuration: plugin "@semantic-release\/git"/);
  assert.equal(gr('tag'), '');
  assert.equal(api.calls.length, 0);
});
