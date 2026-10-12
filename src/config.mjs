// .releaserc loading and validation. Anything this action does not reproduce
// exactly is rejected up front, before a single side effect, so a config that
// relies on unsupported semantic-release behaviour fails loudly instead of
// releasing differently.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RELEASE_TYPES } from './analyze.mjs';

export class ReleaseError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ANALYZER = '@semantic-release/commit-analyzer';
const NOTES = '@semantic-release/release-notes-generator';
const NPM = '@semantic-release/npm';
const GITHUB = '@semantic-release/github';
const DEFAULT_PLUGINS = [ANALYZER, NOTES, NPM, GITHUB];

// The only failCommentCondition template recognised: it always evaluates false.
const ALWAYS_FALSE_TEMPLATE = /^\s*<%\s*return\s+false;?\s*%>\s*$/;

const OTHER_CONFIG_FILES = [
  '.releaserc.json', '.releaserc.yaml', '.releaserc.yml', '.releaserc.js', '.releaserc.cjs', '.releaserc.mjs',
  'release.config.js', 'release.config.cjs', 'release.config.mjs', 'release.config.ts',
];

function unsupported(what) {
  return new ReleaseError('EUNSUPPORTED', `Unsupported configuration: ${what}`,
    'gha-semantic-tag-vanilla reproduces only the semantic-release features listed in its README. '
    + 'Remove this setting, or keep using semantic-release for this repository.');
}

function checkKeys(where, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw unsupported(`${where} option "${key}"`);
  }
}

function checkPlainString(where, value) {
  if (typeof value !== 'string') throw unsupported(`${where} must be a string`);
  if (value.includes('<%') || value.includes('${')) throw unsupported(`${where} templates`);
}

function checkReleaseRules(rules) {
  if (!Array.isArray(rules)) throw unsupported('releaseRules must be an inline array (module paths are not supported)');
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || rule.release === undefined) {
      throw new ReleaseError('EINVALIDCONFIG', 'Error in commit-analyzer configuration: rules must be an object with a "release" property');
    }
    if (!RELEASE_TYPES.includes(rule.release) && rule.release !== null && rule.release !== false) {
      throw new ReleaseError('EINVALIDCONFIG', `Error in commit-analyzer configuration: "${rule.release}" is not a valid release type. Valid values are: ${JSON.stringify(RELEASE_TYPES)}`);
    }
    if (['premajor', 'preminor', 'prepatch', 'prerelease'].includes(rule.release)) throw unsupported(`prerelease release type "${rule.release}"`);
    for (const [key, value] of Object.entries(rule)) {
      if (key === 'release' || key === 'breaking' || key === 'revert') continue;
      if (value !== null && typeof value === 'object') throw unsupported(`releaseRules object value for "${key}"`);
      if (typeof value === 'string' && /[[\]()+@]/.test(value)) throw unsupported(`releaseRules glob "${value}" (only *, ?, {a,b} and a leading ! are supported)`);
    }
  }
  return rules;
}

function normalizePlugin(entry) {
  const [name, options = {}] = Array.isArray(entry) ? entry : [entry, {}];
  if (typeof name !== 'string') throw unsupported('inline plugin definitions');
  if (!DEFAULT_PLUGINS.includes(name)) throw unsupported(`plugin "${name}"`);
  if (typeof options !== 'object' || options === null) throw unsupported(`options of ${name}`);
  return { name, options };
}

export function normalizeConfig(raw, { currentBranch } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError('EINVALIDCONFIG', '.releaserc must contain a JSON object');
  checkKeys('top-level', raw, ['branches', 'tagFormat', 'plugins', 'repositoryUrl', 'preset', 'releaseRules']);

  // branches: exactly one plain release branch.
  let branches;
  if (raw.branches === undefined) {
    branches = ['master', 'main'].includes(currentBranch) ? [currentBranch] : ['main'];
  } else {
    const list = Array.isArray(raw.branches) ? raw.branches : [raw.branches];
    branches = list.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object' && Object.keys(b).length === 1 && typeof b.name === 'string') return b.name;
      throw unsupported('branch objects (prerelease, channel, range)');
    });
    if (branches.length !== 1) throw unsupported('more than one release branch');
    if (/[*?{}[\]()+!@]/.test(branches[0])) throw unsupported(`branch pattern "${branches[0]}"`);
  }

  const tagFormat = raw.tagFormat ?? 'v${version}';
  if (typeof tagFormat !== 'string' || tagFormat.split('${version}').length !== 2 || /<%|\$\{(?!version\})/.test(tagFormat)) {
    throw unsupported(`tagFormat "${tagFormat}" (it must contain \${version} exactly once and no other template)`);
  }

  if (raw.preset !== undefined && raw.preset !== 'angular') throw unsupported(`preset "${raw.preset}"`);
  if (raw.repositoryUrl !== undefined && typeof raw.repositoryUrl !== 'string') throw new ReleaseError('EINVALIDCONFIG', 'repositoryUrl must be a string');

  const plugins = (raw.plugins ?? DEFAULT_PLUGINS).map(normalizePlugin);
  const names = plugins.map((p) => p.name);
  if (new Set(names).size !== names.length) throw unsupported('the same plugin listed twice');
  const find = (name) => plugins.find((p) => p.name === name);

  // commit-analyzer is always there: semantic-release falls back to it.
  const analyzerOpts = { ...(raw.releaseRules !== undefined ? { releaseRules: raw.releaseRules } : {}), ...(find(ANALYZER)?.options || {}) };
  checkKeys(ANALYZER, analyzerOpts, ['preset', 'releaseRules']);
  if (analyzerOpts.preset !== undefined && analyzerOpts.preset !== 'angular') throw unsupported(`${ANALYZER} preset "${analyzerOpts.preset}"`);
  const releaseRules = analyzerOpts.releaseRules === undefined ? undefined : checkReleaseRules(analyzerOpts.releaseRules);

  let notes = false;
  if (find(NOTES)) {
    const opts = find(NOTES).options;
    checkKeys(NOTES, opts, ['preset']);
    if (opts.preset !== undefined && opts.preset !== 'angular') throw unsupported(`${NOTES} preset "${opts.preset}"`);
    notes = true;
  }

  let npm = null;
  if (find(NPM)) {
    const opts = find(NPM).options;
    checkKeys(NPM, opts, ['npmPublish']);
    if (opts.npmPublish !== undefined && typeof opts.npmPublish !== 'boolean') throw new ReleaseError('EINVALIDNPMPUBLISH', 'The npmPublish option, if defined, must be a Boolean.');
    npm = { npmPublish: opts.npmPublish };
  }

  let github = null;
  if (find(GITHUB)) {
    const opts = find(GITHUB).options;
    checkKeys(GITHUB, opts, ['successComment', 'successCommentCondition', 'failComment', 'failCommentCondition', 'failTitle', 'labels', 'releasedLabels', 'assignees']);
    for (const key of ['successComment', 'successCommentCondition', 'failComment']) {
      if (opts[key] !== undefined && opts[key] !== false) throw unsupported(`${GITHUB} ${key} other than false`);
    }
    let failCondition = opts.failCommentCondition;
    if (failCondition !== undefined && failCondition !== false) {
      if (typeof failCondition !== 'string' || !ALWAYS_FALSE_TEMPLATE.test(failCondition)) {
        throw unsupported(`${GITHUB} failCommentCondition (only false or "<% return false; %>")`);
      }
      failCondition = 'always-false';
    }
    if (opts.failTitle !== undefined && opts.failTitle !== false) checkPlainString(`${GITHUB} failTitle`, opts.failTitle);
    const list = (key, fallback) => {
      const value = opts[key];
      if (value === undefined || value === null) return fallback;
      if (value === false) return false;
      const arr = Array.isArray(value) ? value : [value];
      arr.forEach((v) => checkPlainString(`${GITHUB} ${key}`, v));
      return arr;
    };
    github = {
      // semantic-release's success step only checks for literal `false`
      // here, so a template that evaluates false still closes old failure issues.
      closeFailIssues: !(opts.failComment === false || opts.failTitle === false || opts.failCommentCondition === false),
      openFailIssue: !(opts.failComment === false || opts.failTitle === false || failCondition !== undefined),
      successComment: !(opts.successComment === false || opts.successCommentCondition === false),
      failTitle: opts.failTitle || 'The automated release is failing 🚨',
      labels: list('labels', ['semantic-release']),
      releasedLabels: list('releasedLabels', ['released']),
      assignees: list('assignees', undefined),
    };
  }

  return { branches, tagFormat, repositoryUrl: raw.repositoryUrl, plugins: names, releaseRules, notes, npm, github };
}

export function loadConfig(cwd, options) {
  const path = join(cwd, '.releaserc');
  const others = OTHER_CONFIG_FILES.filter((f) => existsSync(join(cwd, f)));
  if (others.length) throw unsupported(`config file ${others.join(', ')} (only a JSON .releaserc is read)`);
  let raw = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ReleaseError('EINVALIDCONFIG', `.releaserc is not valid JSON: ${error.message}`);
    }
  } else {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath) && JSON.parse(readFileSync(pkgPath, 'utf8')).release !== undefined) {
      throw unsupported('package.json "release" key (move it to .releaserc)');
    }
  }
  return normalizeConfig(raw, options);
}
