// Version bump and release notes must match the real semantic-release
// plugins exactly. The fixtures are their output (scripts/golden.mjs) for
// hand-written edge cases and for every release in the histories of
// 3h4x/mcp-http-tools and 3h4x/tamtam.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { analyzeCommits } from '../src/analyze.mjs';
import { generateNotes } from '../src/notes.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.golden.json'));

for (const file of files) {
  const cases = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  test(`${file}: ${cases.length} releases match semantic-release`, () => {
    for (const c of cases) {
      const { releaseType } = analyzeCommits(c.commits, c.analyzerConfig?.releaseRules);
      assert.equal(releaseType, c.releaseType, `${c.name}: release type`);
      const notes = generateNotes(c.commits, {
        repositoryUrl: c.repositoryUrl || 'https://github.com/o/r',
        version: c.version,
        previousTag: c.lastTag,
        currentTag: c.nextTag,
        date: 'DATE',
      });
      assert.equal(notes, c.notes, `${c.name}: notes`);
    }
  });
}

test('fixtures are present', () => {
  assert.ok(files.includes('cases.golden.json'));
  assert.ok(files.length >= 3);
});
