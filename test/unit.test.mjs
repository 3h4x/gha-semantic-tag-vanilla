import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeCommit, globMatch } from '../src/analyze.mjs';
import { closedIssueNumbers, failComment, successComment } from '../src/comments.mjs';
import { loadConfig, normalizeConfig } from '../src/config.mjs';
import { repositoryContext } from '../src/notes.mjs';
import { getRegistry, nerfDart } from '../src/npm.mjs';
import { CommitParser } from '../src/parser.mjs';
import { lastRelease, makeTag, nextVersion, parseVersion, releaseTags } from '../src/version.mjs';

const MCP_RELEASERC = {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', { releaseRules: [{ breaking: true, release: 'major' }, { type: 'feat', release: 'minor' }, { type: 'docs', release: 'patch' }] }],
    '@semantic-release/release-notes-generator',
    ['@semantic-release/npm', { npmPublish: true }],
    ['@semantic-release/github', { failCommentCondition: '<% return false; %>' }],
  ],
};

test('config: mcp-http-tools .releaserc is accepted as is', () => {
  const config = normalizeConfig(MCP_RELEASERC);
  assert.deepEqual(config.branches, ['main']);
  assert.equal(config.tagFormat, 'v${version}');
  assert.deepEqual(config.plugins, ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/npm', '@semantic-release/github']);
  assert.equal(config.releaseRules.length, 3);
  assert.deepEqual(config.npm, { npmPublish: true });
  assert.equal(config.github.openFailIssue, false);
  // success only skips closing for a literal `false`
  assert.equal(config.github.closeFailIssues, true);
  assert.deepEqual(config.github.releasedLabels, ['released']);
});

test('config: tamtam .releaserc (github defaults) is accepted', () => {
  const config = normalizeConfig({ branches: ['master'], plugins: ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/github'] });
  assert.equal(config.npm, null);
  assert.equal(config.github.openFailIssue, true);
  assert.equal(config.github.failTitle, 'The automated release is failing 🚨');
  assert.deepEqual(config.github.labels, ['semantic-release']);
});

test('config: defaults when .releaserc is empty', () => {
  const config = normalizeConfig({}, { currentBranch: 'master' });
  assert.deepEqual(config.branches, ['master']);
  assert.deepEqual(config.plugins, ['@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/npm', '@semantic-release/github']);
  assert.equal(config.releaseRules, undefined);
});

test('config: unsupported features fail loudly', () => {
  const bad = [
    { branches: ['main', 'next'] },
    { branches: [{ name: 'beta', prerelease: true }] },
    { branches: ['+([0-9])?(.{+([0-9]),x}).x'] },
    { plugins: ['@semantic-release/git'] },
    { plugins: ['@semantic-release/changelog'] },
    { plugins: [['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }]] },
    { plugins: [['@semantic-release/commit-analyzer', { releaseRules: './rules.js' }]] },
    { plugins: [['@semantic-release/github', { assets: ['dist/*.zip'] }]] },
    { plugins: [['@semantic-release/github', { successComment: 'Shipped in ${nextRelease.version}' }]] },
    { plugins: [['@semantic-release/github', { failCommentCondition: '<% return issue.number > 1; %>' }]] },
    { plugins: [['@semantic-release/npm', { tarballDir: 'dist' }]] },
    { tagFormat: '${version}-${foo}' },
    { tagFormat: 'release' },
    { extends: 'semantic-release-monorepo' },
    { plugins: [['@semantic-release/commit-analyzer', { releaseRules: [{ type: 'feat', release: 'prerelease' }] }]] },
  ];
  for (const raw of bad) assert.throws(() => normalizeConfig(raw, { currentBranch: 'main' }), /Unsupported configuration/, JSON.stringify(raw));
  assert.throws(() => normalizeConfig({ plugins: [['@semantic-release/commit-analyzer', { releaseRules: [{ type: 'feat', release: 'huge' }] }]] }), /not a valid release type/);
});

test('config: other config files are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gstv-cfg-'));
  writeFileSync(join(dir, 'release.config.js'), 'module.exports = {}');
  assert.throws(() => loadConfig(dir, { currentBranch: 'main' }), /release\.config\.js/);
  const dir2 = mkdtempSync(join(tmpdir(), 'gstv-cfg-'));
  writeFileSync(join(dir2, '.releaserc'), '{ not json');
  assert.throws(() => loadConfig(dir2, { currentBranch: 'main' }), /not valid JSON/);
});

test('version: tags, last release, increments', () => {
  const tags = releaseTags(['v1.0.0', 'v1.10.0', 'v1.9.3', 'v2.0.0-beta.1', 'foo', 'v1.2', 'vx.y.z', 'release-3.0.0'], 'v${version}');
  assert.deepEqual(tags.map((t) => t.gitTag), ['v1.0.0', 'v1.10.0', 'v1.9.3', 'v2.0.0-beta.1']);
  assert.equal(lastRelease(tags).gitTag, 'v1.10.0');
  assert.equal(lastRelease(tags, { before: '1.10.0' }).gitTag, 'v1.9.3');
  assert.equal(lastRelease([]), null);
  assert.equal(nextVersion(null, 'minor'), '1.0.0');
  assert.equal(nextVersion({ version: '1.9.3' }, 'patch'), '1.9.4');
  assert.equal(nextVersion({ version: '1.9.3' }, 'minor'), '1.10.0');
  assert.equal(nextVersion({ version: '1.9.3' }, 'major'), '2.0.0');
  assert.equal(makeTag('release-${version}', '2.0.0'), 'release-2.0.0');
  assert.deepEqual(releaseTags(['release-2.0.0', 'v1.0.0'], 'release-${version}').map((t) => t.version), ['2.0.0']);
  assert.equal(parseVersion('01.0.0'), null);
});

test('analyze: glob subset and rule precedence', () => {
  assert.ok(globMatch('deps-dev', 'deps*'));
  assert.ok(globMatch('x', '{x,y}'));
  assert.ok(!globMatch('z', '{x,y}'));
  assert.ok(globMatch('z', '!{x,y}'));
  assert.ok(globMatch('ab', 'a?'));
  assert.ok(!globMatch('a.b', 'a'));
  const parse = (m) => new CommitParser().parse(m);
  // the highest matching rule wins within one rule list
  assert.equal(analyzeCommit([{ type: 'feat', release: 'patch' }, { scope: 'api', release: 'major' }], parse('feat(api): x')), 'major');
  assert.equal(analyzeCommit([{ type: 'chore', release: 'patch' }], parse('feat: x')), undefined);
});

test('notes: repository URL forms', () => {
  const expected = { host: 'https://github.com', owner: '3h4x', repository: 'mcp-http-tools' };
  assert.deepEqual(repositoryContext('git+https://github.com/3h4x/mcp-http-tools.git'), expected);
  assert.deepEqual(repositoryContext('git@github.com:3h4x/mcp-http-tools.git'), expected);
  assert.deepEqual(repositoryContext('https://github.com/3h4x/mcp-http-tools'), expected);
});

test('comments: success and fail texts', () => {
  assert.equal(successComment({ pull_request: true }, [{ name: 'GitHub release', url: 'https://x/r' }], '1.2.3'),
    ':tada: This PR is included in version 1.2.3 :tada:\n\nThe release is available on [GitHub release](https://x/r)\n\nYour **[semantic-release](https://github.com/semantic-release/semantic-release)** bot :package::rocket:');
  assert.match(successComment({}, [{ name: 'npm package (@latest dist-tag)' }, { name: 'GitHub release', url: 'u' }], '2.0.0'),
    /This issue has been resolved in version 2\.0\.0 :tada:\n\nThe release is available on:\n- `npm package \(@latest dist-tag\)`\n- \[GitHub release\]\(u\)/);
  const fail = failComment('main', [{ message: 'Boom', details: 'Fix it.' }]);
  assert.match(fail, /The automated release from the `main` branch failed/);
  assert.match(fail, /### Boom\n\nFix it\./);
});

test('comments: closed issue references', () => {
  assert.deepEqual(closedIssueNumbers('Fixes #1, #2 and #3\nresolves o/r#4 closes other/repo#5', 'o', 'r'), [1, 2, 3, 4]);
  assert.deepEqual(closedIssueNumbers('see #9, closes https://github.com/o/r/issues/10', 'o', 'r'), [10]);
  assert.deepEqual(closedIssueNumbers('Closes: #11', 'o', 'r'), [11]);
  assert.deepEqual(closedIssueNumbers(null, 'o', 'r'), []);
});

test('npm: registry resolution and nerf dart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gstv-npm-'));
  assert.equal(getRegistry({ name: 'a', publishConfig: { registry: 'https://npm.pkg.github.com' } }, dir, {}), 'https://npm.pkg.github.com');
  assert.equal(getRegistry({ name: 'a' }, dir, { NPM_CONFIG_REGISTRY: 'https://r.example/' }), 'https://r.example/');
  writeFileSync(join(dir, '.npmrc'), '@me:registry=https://npm.pkg.github.com\n');
  assert.equal(getRegistry({ name: '@me/pkg' }, dir, {}), 'https://npm.pkg.github.com');
  assert.equal(getRegistry({ name: 'plain' }, dir, {}), 'https://registry.npmjs.org/');
  assert.equal(nerfDart('https://npm.pkg.github.com'), '//npm.pkg.github.com/');
  assert.equal(nerfDart('https://r.example/sub/path'), '//r.example/sub/path/');
});
