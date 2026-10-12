// Release notes: @semantic-release/release-notes-generator 14 with the angular
// preset (conventional-changelog-angular 8.3.1, conventional-changelog-writer
// 8.4.0). The writer's handlebars templates are rendered here by hand; the
// whitespace below reproduces what those templates emit, checked against the
// original by test/parity.test.mjs.

import { parseCommits, filterReverted } from './parser.mjs';
import { parseVersion } from './version.mjs';

const TYPE_TITLES = {
  docs: 'Documentation',
  style: 'Styles',
  refactor: 'Code Refactoring',
  test: 'Tests',
  build: 'Build System',
  ci: 'Continuous Integration',
};

// "https://github.com/owner/repo(.git)" or "git@github.com:owner/repo.git"
// -> { host: 'https://github.com', owner, repository }
export function repositoryContext(repositoryUrl) {
  const url = repositoryUrl.replace(/\.git$/i, '');
  const scp = /^(?!.+:\/\/)(?:(?<auth>.*)@)?(?<host>.*?):(?<path>.*)$/.exec(url);
  const parsed = new URL(scp ? `ssh://${scp.groups.auth ? `${scp.groups.auth}@` : ''}${scp.groups.host}/${scp.groups.path}` : url);
  const port = parsed.protocol.includes('ssh') ? '' : parsed.port;
  const protocol = /http[^s]/.test(parsed.protocol) ? 'http' : 'https';
  const [, owner, repository] = /^\/(?<owner>[^/]+)?\/?(?<repository>.+)?$/.exec(parsed.pathname) || [];
  return { host: `${protocol}://${parsed.hostname}${port ? `:${port}` : ''}`, owner, repository };
}

// The angular preset's writer `transform`. Returns null for discarded commits.
function transform(commit, ctx) {
  let discard = true;
  const notes = commit.notes.map((note) => {
    discard = false;
    return { ...note, title: 'BREAKING CHANGES' };
  });
  let { type } = commit;
  if (commit.type === 'feat') type = 'Features';
  else if (commit.type === 'fix') type = 'Bug Fixes';
  else if (commit.type === 'perf') type = 'Performance Improvements';
  else if (commit.type === 'revert' || commit.revert) type = 'Reverts';
  else if (discard) return null;
  else if (TYPE_TITLES[commit.type]) type = TYPE_TITLES[commit.type];

  const scope = commit.scope === '*' ? '' : commit.scope;
  const shortHash = commit.hash.substring(0, 7);
  const issues = [];
  let { subject } = commit;
  if (typeof subject === 'string') {
    const url = `${ctx.host}/${ctx.owner}/${ctx.repository}/issues/`;
    subject = subject.replace(/#([0-9]+)/g, (_, issue) => {
      issues.push(issue);
      return `[#${issue}](${url}${issue})`;
    });
    subject = subject.replace(/`[^`]*`|\B@([a-z0-9](?:-?[a-z0-9/]){0,38})/g, (match, username) => {
      if (!username) return match;
      if (username.includes('/')) return `@${username}`;
      return `[@${username}](${ctx.host}/${username})`;
    });
  }
  const references = commit.references.filter((reference) => !issues.includes(reference.issue));
  return { ...commit, notes, type, scope, shortHash, subject, references, raw: commit };
}

function compareStrings(keys) {
  return (a, b) => {
    const x = keys.map((k) => a[k] || '').join('');
    const y = keys.map((k) => b[k] || '').join('');
    return x.localeCompare(y);
  };
}

function renderCommit(commit, ctx) {
  const repo = `${ctx.host}/${ctx.owner}/${ctx.repository}`;
  let line = `*${commit.scope ? ` **${commit.scope}:**` : ''} ${commit.subject ? commit.subject : commit.header}`;
  line += ` ([${commit.shortHash}](${repo}/commit/${commit.hash}))`;
  if (commit.references.length) {
    line += ', closes';
    for (const ref of commit.references) {
      const label = `${ref.owner ? `${ref.owner}/` : ''}${ref.repository || ''}#${ref.issue}`;
      const target = ref.repository
        ? `${ctx.host}/${ref.owner ? `${ref.owner}/` : ''}${ref.repository}`
        : repo;
      line += ` [${label}](${target}/issues/${ref.issue})`;
    }
  }
  return line;
}

// commits: [{ hash, message }] from `git log` (newest first).
// ctx: { repositoryUrl, version, previousTag, currentTag, date: 'YYYY-MM-DD' }
export function generateNotes(commits, { repositoryUrl, version, previousTag, currentTag, date }) {
  const ctx = { ...repositoryContext(repositoryUrl), version };
  const transformed = filterReverted(
    parseCommits(commits).map((commit) => transform(commit, ctx)).filter(Boolean),
  );

  const notes = [];
  for (const commit of transformed) {
    for (const note of commit.notes) notes.push({ ...note, commit });
  }

  const groups = new Map();
  for (const commit of transformed) {
    const key = commit.type || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(commit);
  }
  const commitGroups = [...groups.entries()]
    .map(([title, list]) => ({ title, commits: list.sort(compareStrings(['scope', 'subject'])) }))
    .sort(compareStrings(['title']));

  const noteGroups = [];
  for (const note of notes) {
    let group = noteGroups.find((g) => g.title === note.title);
    if (!group) noteGroups.push((group = { title: note.title, notes: [] }));
    group.notes.push(note);
  }
  noteGroups.sort(compareStrings(['title']));

  const isPatch = parseVersion(version).patch !== 0;
  const linkCompare = Boolean(currentTag && previousTag);
  const repo = `${ctx.host}/${ctx.owner}/${ctx.repository}`;
  let out = `${isPatch ? '##' : '#'} ${linkCompare ? `[${version}](${repo}/compare/${previousTag}...${currentTag})` : version} (${date})\n`;

  for (const group of commitGroups) {
    out += '\n\n';
    if (group.title) out += `### ${group.title}\n\n`;
    for (const commit of group.commits) out += `${renderCommit(commit, ctx)}\n`;
  }
  for (const group of noteGroups) {
    out += `\n\n### ${group.title}\n\n`;
    for (const note of group.notes) {
      out += `* ${note.commit.scope ? `**${note.commit.scope}:** ` : ''}${note.text}\n`;
    }
  }
  const rendered = out.trim();
  return rendered.length > 0 ? `${rendered}\n` : '';
}
