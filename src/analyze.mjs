// Release type from commits: a port of @semantic-release/commit-analyzer 13.

import { parseCommits, withoutSkipped } from './parser.mjs';

export const RELEASE_TYPES = ['major', 'premajor', 'minor', 'preminor', 'patch', 'prepatch', 'prerelease'];

export const DEFAULT_RELEASE_RULES = [
  { breaking: true, release: 'major' },
  { revert: true, release: 'patch' },
  // Angular
  { type: 'feat', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'perf', release: 'patch' },
  // The analyzer's defaults also carry rules for other presets (Atom emoji,
  // Ember/ESLint tags, Express components, JSHint upper-case types). With the
  // angular parser those fields are never set, so only the JSHint ones can match.
  { type: 'FEAT', release: 'minor' },
  { type: 'FIX', release: 'patch' },
];

function isHigher(current, candidate) {
  return !current || RELEASE_TYPES.indexOf(candidate) < RELEASE_TYPES.indexOf(current);
}

// The subset of micromatch used for rule values: `*`, `?`, `{a,b}` and a
// leading `!`. config.mjs rejects patterns using anything else.
export function globMatch(value, pattern) {
  if (pattern.startsWith('!') && pattern.length > 1) return !globMatch(value, pattern.slice(1));
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      while (pattern[i + 1] === '*') i++;
      source += i === 0 || source === '' ? '(?!\\.)[^/]*' : '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        source += '\\{';
      } else {
        const options = pattern.slice(i + 1, end).split(',').map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        source += `(?:${options.join('|')})`;
        i = end;
      }
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(value);
}

function ruleMatches(rule, commit) {
  const { breaking, revert, release, ...fields } = rule;
  if (breaking && !(commit.notes && commit.notes.length > 0)) return false;
  if (revert && !commit.revert) return false;
  return Object.entries(fields).every(([key, expected]) => {
    const actual = commit[key];
    if (typeof expected === 'string' && typeof actual === 'string') return globMatch(actual, expected);
    return actual === expected;
  });
}

export function analyzeCommit(rules, commit) {
  let releaseType;
  for (const rule of rules) {
    if (!ruleMatches(rule, commit)) continue;
    if (isHigher(releaseType, rule.release)) {
      releaseType = rule.release;
      if (releaseType === RELEASE_TYPES[0]) break;
    }
  }
  return releaseType;
}

// Returns 'major' | 'minor' | 'patch' | null, plus a per-commit log.
export function analyzeCommits(commits, releaseRules) {
  let releaseType = null;
  const log = [];
  for (const commit of parseCommits(withoutSkipped(commits))) {
    let commitType;
    if (releaseRules) commitType = analyzeCommit(releaseRules, commit);
    if (commitType === undefined) commitType = analyzeCommit(DEFAULT_RELEASE_RULES, commit);
    log.push({ hash: commit.hash, header: commit.header, release: commitType || null });
    if (commitType && isHigher(releaseType, commitType)) releaseType = commitType;
    if (releaseType === RELEASE_TYPES[0]) break;
  }
  return { releaseType, log };
}
