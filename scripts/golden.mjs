#!/usr/bin/env node
// Regenerates the parity fixtures from the REAL semantic-release plugins.
//
// This is the only place semantic-release is used, and it is never a
// dependency of the action: install it in a throwaway directory and point
// SR_NODE_MODULES at that directory's node_modules.
//
//   mkdir -p /tmp/sr && cd /tmp/sr && npm init -y && npm i semantic-release@25.0.9
//   SR_NODE_MODULES=/tmp/sr/node_modules node scripts/golden.mjs cases
//   SR_NODE_MODULES=/tmp/sr/node_modules node scripts/golden.mjs history <repo-dir> <name> [branch]
//
// `cases` turns test/fixtures/cases.input.json into cases.golden.json.
// `history` walks every release tag of a local clone and writes
// test/fixtures/history-<name>.golden.json.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.SR_NODE_MODULES;
if (!modules) throw new Error('Set SR_NODE_MODULES to a node_modules containing semantic-release');
const load = async (name, entry) =>
  import(pathToFileURL(join(modules, name, entry ?? JSON.parse(readFileSync(join(modules, name, 'package.json'))).exports?.['.']?.default ?? 'index.js')).href);
const { analyzeCommits } = await load('@semantic-release/commit-analyzer', 'index.js');
const { generateNotes } = await load('@semantic-release/release-notes-generator', 'index.js');

const logger = { log() {}, warn() {}, error() {} };
const today = new Date().toISOString().slice(0, 10);

async function oracle(c) {
  const ctx = {
    commits: c.commits.map(({ hash, message }) => ({ hash, message })),
    logger,
    cwd: '/nonexistent',
    options: { repositoryUrl: c.repositoryUrl || 'https://github.com/o/r' },
    lastRelease: c.lastTag ? { gitTag: c.lastTag, gitHead: c.lastTag } : {},
    nextRelease: { version: c.version, gitTag: c.nextTag, gitHead: 'HEAD' },
  };
  // semantic-release core drops these before analysis (definitions/plugins.js).
  const analyzed = { ...ctx, commits: ctx.commits.filter((x) => !/\[skip\s+release]|\[release\s+skip]/i.test(x.message)) };
  const releaseType = (await analyzeCommits(c.analyzerConfig || {}, analyzed)) ?? null;
  const notes = (await generateNotes({}, ctx)).split(`(${today})`).join('(DATE)');
  return { ...c, releaseType, notes };
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const [mode, repoDir, name, branch = 'HEAD'] = process.argv.slice(2);
if (mode === 'cases') {
  const { cases } = JSON.parse(readFileSync('test/fixtures/cases.input.json', 'utf8'));
  const out = [];
  for (const c of cases) out.push(await oracle(c));
  writeFileSync('test/fixtures/cases.golden.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(`cases.golden.json: ${out.length} cases`);
} else if (mode === 'history') {
  const rc = JSON.parse(readFileSync(join(repoDir, '.releaserc'), 'utf8'));
  const analyzerConfig = (rc.plugins || [])
    .map((p) => (Array.isArray(p) ? p : [p, {}]))
    .find(([p]) => p === '@semantic-release/commit-analyzer')?.[1] || {};
  const tags = git(repoDir, 'tag', '--merged', branch).split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const cmp = (a, b) => { const x = a.slice(1).split('.').map(Number); const y = b.slice(1).split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  tags.sort(cmp);
  const remote = git(repoDir, 'remote', 'get-url', 'origin').trim();
  const out = [];
  for (let i = 0; i < tags.length; i++) {
    const prev = tags[i - 1];
    const range = prev ? `${prev}..${tags[i]}` : tags[i];
    const raw = git(repoDir, 'log', '--format=%H%x00%B%x00%x01', range);
    const commits = raw.split('\x01').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((s) => {
      const [hash, message] = s.split('\x00');
      return { hash, message: message.trim() };
    });
    out.push(await oracle({ name: `${name} ${range}`, version: tags[i].slice(1), lastTag: prev, nextTag: tags[i], repositoryUrl: remote, commits, analyzerConfig }));
  }
  writeFileSync(`test/fixtures/history-${name}.golden.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`history-${name}.golden.json: ${out.length} releases`);
} else {
  throw new Error('usage: golden.mjs cases | history <repo-dir> <name> [branch]');
}
