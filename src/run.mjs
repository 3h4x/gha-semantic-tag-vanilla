// The release pipeline, in semantic-release's order:
// verify -> (recover) -> analyze -> notes -> prepare -> tag -> publish -> success,
// and fail on an error. All I/O comes in through `deps` so tests can drive it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeCommits } from './analyze.mjs';
import { closedIssueNumbers, failComment, ISSUE_ID, RELEASE_FAIL_LABEL, RELEASE_NAME, successComment } from './comments.mjs';
import { loadConfig, ReleaseError } from './config.mjs';
import { generateNotes, repositoryContext } from './notes.mjs';
import { lastRelease, makeTag, nextVersion, releaseTags } from './version.mjs';

const today = (now) => now().toISOString().slice(0, 10);

function currentBranch(env, git) {
  if (env.GITHUB_REF?.startsWith('refs/heads/')) return env.GITHUB_REF.slice('refs/heads/'.length);
  return git.currentBranch();
}

// Repository URL as semantic-release resolves it: config, then package.json,
// then the origin remote.
function resolveRepositoryUrl(config, pkg, git) {
  if (config.repositoryUrl) return config.repositoryUrl;
  const fromPkg = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  if (fromPkg) return fromPkg;
  const origin = git.remoteUrl();
  if (!origin) throw new ReleaseError('ENOREPOURL', 'The repositoryUrl option is required.', 'Set repositoryUrl in .releaserc, the repository field in package.json, or an origin remote.');
  return origin.replace(/^(https?:\/\/)[^@/]*@/, '$1');
}

export async function run(deps) {
  const { cwd, env, dryRun, git, createGitHub, npm, log, warn, now = () => new Date() } = deps;
  const result = { published: false, recovered: null };

  if (/^pull_request/.test(env.GITHUB_EVENT_NAME || '')) {
    log("This run was triggered by a pull request and therefore a new version won't be published.");
    return result;
  }

  const branch = currentBranch(env, git);
  const config = loadConfig(cwd, { currentBranch: branch });
  if (!config.branches.includes(branch)) {
    log(`This test run was triggered on the branch ${branch}, while semantic-release is configured to only publish from ${config.branches.join(', ')}, therefore a new version won't be published.`);
    return result;
  }

  let pkg = null;
  try { pkg = npm.readPackage(); } catch { /* only required by the npm plugin, checked below */ }
  const repositoryUrl = resolveRepositoryUrl(config, pkg, git);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const [owner, repo] = (env.GITHUB_REPOSITORY || `${repositoryContext(repositoryUrl).owner}/${repositoryContext(repositoryUrl).repository}`).split('/');
  const github = config.github ? createGitHub({ token, owner, repo, apiUrl: env.GITHUB_API_URL }) : null;
  const errors = [];

  // Errors from here on open the failure issue (when configured).
  try {
    // --- verify --------------------------------------------------------------
    git.fetchTags('origin', git.isShallow());
    git.fetchNotes('origin');

    const head = git.head();
    if (git.remoteBranchHead('origin', branch) !== head) {
      log(`The local branch ${branch} is behind the remote one, therefore a new version won't be published.`);
      return result;
    }

    let pushRemote = 'origin';
    if (!git.verifyPush('origin', branch)) {
      const host = new URL(env.GITHUB_SERVER_URL || 'https://github.com').host;
      const authUrl = token ? `https://x-access-token:${token}@${host}/${owner}/${repo}.git` : null;
      if (authUrl && git.verifyPush(authUrl, branch)) {
        pushRemote = authUrl;
      } else {
        const error = new ReleaseError('EGITNOPERMISSION', `Cannot push to the Git repository.`,
          `The token in GITHUB_TOKEN must allow pushing to ${owner}/${repo} (permissions: contents: write), and actions/checkout must keep its credentials or the token must be passed to this action.`);
        if (!dryRun) throw error;
        warn(`${error.message} ${error.details} (ignored in dry-run)`);
      }
    }

    if (config.github && !token) {
      throw new ReleaseError('ENOGHTOKEN', 'No GitHub token specified.', 'A GitHub personal token or GITHUB_TOKEN must be set in the GH_TOKEN or GITHUB_TOKEN environment variable.');
    }
    if (config.npm) npm.verify(config.npm);

    const tags = releaseTags(git.mergedTags(), config.tagFormat);

    // --- recover a release whose tag was pushed but never published ----------
    const latest = lastRelease(tags);
    if (latest && github && git.remoteTagExists(pushRemote, latest.gitTag) && !(await github.getReleaseByTag(latest.gitTag))) {
      result.recovered = latest.gitTag;
      if (dryRun) {
        warn(`${latest.gitTag} has no GitHub release; a real run would publish it before analysing new commits.`);
      } else {
        warn(`${latest.gitTag} was tagged but never published; finishing that release first.`);
        await publishRelease({
          ...deps, config, github, repositoryUrl, branch, pushRemote,
          version: latest.version, gitTag: latest.gitTag, previous: lastRelease(tags, { before: latest.version }), recovering: true,
        });
      }
    }

    // --- analyze ------------------------------------------------------------
    const last = lastRelease(tags);
    result.lastRelease = last;
    if (!last) log('No previous release found, retrieving all commits');
    const commits = git.log(last?.gitTag, 'HEAD');
    log(`Found ${commits.length} commits since last release`);
    const { releaseType, log: analysis } = analyzeCommits(commits, config.releaseRules);
    for (const entry of analysis) log(`  ${entry.hash.slice(0, 7)} ${entry.header ?? ''} -> ${entry.release || 'no release'}`);
    log(`Analysis of ${commits.length} commits complete: ${releaseType || 'no'} release`);
    if (!releaseType) return result;

    const version = nextVersion(last, releaseType);
    const gitTag = makeTag(config.tagFormat, version);
    if (git.tagExists(gitTag)) throw new ReleaseError('EGITTAGEXISTS', `The tag ${gitTag} already exists.`, `The next version computed from the commits is ${version}, but ${gitTag} is already a tag outside this branch's history. Delete or move it, then re-run.`);
    log(`The next release version is ${version}`);

    const notes = config.notes
      ? generateNotes(commits, { repositoryUrl, version, previousTag: last?.gitTag, currentTag: gitTag, date: today(now) })
      : '';
    Object.assign(result, { releaseType, version, gitTag, gitHead: head, notes });

    if (dryRun) {
      log(`Release note for version ${version}:\n${notes}`);
      return result;
    }

    // --- prepare, tag, publish, success ---------------------------------------
    await publishRelease({ ...deps, config, github, repositoryUrl, branch, pushRemote, version, gitTag, previous: last, commits, notes, tagHere: true });
    result.published = true;
    return result;
  } catch (error) {
    errors.push(error);
    if (github && config.github.openFailIssue && !dryRun) {
      try {
        await openFailIssue(github, config.github, branch, errors, log);
      } catch (issueError) {
        warn(`Could not open the failure issue: ${issueError.message}`);
      }
    }
    throw error;
  }
}

// prepare -> tag -> publish -> success for one version. With `recovering`, the
// tag already exists: publish what is missing from it instead.
async function publishRelease(ctx) {
  const { config, git, npm, github, log, warn, now, repositoryUrl, branch, pushRemote, version, gitTag, previous, recovering } = ctx;
  const commits = ctx.commits || git.log(previous?.gitTag, gitTag);
  const notes = ctx.notes ?? (config.notes
    ? generateNotes(commits, { repositoryUrl, version, previousTag: previous?.gitTag, currentTag: gitTag, date: today(now) })
    : '');

  // npm publishes the tree being released; when recovering that is the tag,
  // checked out on the side so the workspace stays at HEAD.
  let npmDir = null;
  if (config.npm && recovering) {
    if (npm.shouldPublish(config.npm, npm.readPackage()) && !npm.versionExists(version)) {
      npmDir = mkdtempSync(join(tmpdir(), 'gstv-recover-'));
      rmSync(npmDir, { recursive: true, force: true });
      git.addWorktree(npmDir, gitTag);
    }
  }

  try {
    if (config.npm && !recovering) npm.prepare(version);
    if (npmDir) npm.prepare(version, npmDir);

    if (!recovering) {
      git.tag(gitTag, 'HEAD');
      git.addNote(gitTag);
      try {
        git.pushTag(pushRemote, gitTag);
      } catch (error) {
        // Leave no local-only tag behind: the next run must not mistake it
        // for a release that only needs publishing.
        git.deleteTag(gitTag);
        throw error;
      }
      git.run(['push', '--', pushRemote, `refs/notes/semantic-release-${gitTag}`], { allowFailure: true }) ?? warn(`Could not push the semantic-release note for ${gitTag}.`);
      log(`Created tag ${gitTag}`);
    }

    // publish, in plugin order (semantic-release's `publish` step)
    const releases = [];
    for (const plugin of config.plugins) {
      if (plugin === '@semantic-release/npm') {
        if (recovering && !npmDir) continue;
        const info = npm.publish(config.npm, version, npmDir || undefined);
        if (info) releases.push(info);
      } else if (plugin === '@semantic-release/github') {
        if (recovering && await github.getReleaseByTag(gitTag)) continue;
        const release = await github.createRelease({
          tag_name: gitTag,
          target_commitish: branch,
          name: gitTag,
          body: notes,
          prerelease: false,
          make_latest: 'true',
        });
        log(`Published GitHub release: ${release.html_url}`);
        releases.push({ name: RELEASE_NAME, url: release.html_url });
      }
    }
    log(`Published release ${version} on default channel`);

    if (github) {
      try {
        await success({ github, config: config.github, commits, releases, version, log, warn });
      } catch (error) {
        warn(`Release ${version} is published, but commenting on issues and pull requests failed: ${error.message}`);
      }
    }
  } finally {
    if (npmDir) git.removeWorktree(npmDir);
  }
}

async function success({ github, config, commits, releases, version, log, warn }) {
  if (config.successComment && commits.length) {
    const shas = commits.map(({ hash }) => hash);
    const candidates = new Map();
    for (const sha of shas) {
      for (const pr of await github.pullsForCommit(sha)) candidates.set(pr.number, pr);
    }
    const prs = [];
    for (const pr of candidates.values()) {
      const prCommits = await github.pullCommits(pr.number);
      const included = prCommits.some(({ sha }) => shas.includes(sha))
        || shas.includes((await github.getPull(pr.number)).merge_commit_sha);
      if (included) prs.push({ ...pr, pull_request: true });
    }

    const issueNumbers = new Set();
    for (const text of [...prs.map((pr) => pr.body), ...commits.map((c) => c.message)]) {
      for (const n of closedIssueNumbers(text, github.owner, github.repo)) issueNumbers.add(n);
    }
    const issues = [];
    for (const number of issueNumbers) {
      const issue = await github.getIssue(number);
      if (issue) issues.push(issue);
    }

    const seen = new Set();
    for (const issue of [...prs, ...issues]) {
      if (seen.has(issue.number)) continue;
      seen.add(issue.number);
      const kind = issue.pull_request ? 'PR' : 'issue';
      try {
        const comment = await github.comment(issue.number, successComment(issue, releases, version));
        log(`Added comment to ${kind} #${issue.number}: ${comment.html_url}`);
        if (config.releasedLabels) {
          await github.addLabels(issue.number, config.releasedLabels);
          log(`Added labels ${JSON.stringify(config.releasedLabels)} to ${kind} #${issue.number}`);
        }
      } catch (error) {
        warn(`Failed to add a comment to the issue/PR #${issue.number}: ${error.message}`);
      }
    }
  } else {
    log('Skip commenting on issues and pull requests.');
  }

  if (config.closeFailIssues) {
    for (const issue of await findFailIssues(github, config)) {
      await github.closeIssue(issue.number);
      log(`Closed issue #${issue.number}: ${issue.html_url}.`);
    }
  }
}

async function findFailIssues(github, config) {
  const labels = [...new Set([...(config.labels || []), RELEASE_FAIL_LABEL])];
  const found = new Map();
  for (const label of labels) {
    for (const issue of await github.openIssuesWithLabel(label)) {
      const issueLabels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
      if (labels.every((l) => issueLabels.includes(l)) && issue.body?.includes(ISSUE_ID)) found.set(issue.number, issue);
    }
  }
  return [...found.values()];
}

async function openFailIssue(github, config, branch, errors, log) {
  const body = failComment(branch, errors.map((e) => ({ message: e.message, details: e.details })));
  const [existing] = await findFailIssues(github, config);
  if (existing) {
    const comment = await github.comment(existing.number, body);
    log(`Added comment to issue #${existing.number}: ${comment.html_url}.`);
    return;
  }
  const issue = await github.createIssue({
    title: config.failTitle,
    body: `${body}\n\n${ISSUE_ID}`,
    labels: [...(config.labels || []), RELEASE_FAIL_LABEL],
    ...(config.assignees ? { assignees: config.assignees } : {}),
  });
  log(`Created issue #${issue.number}: ${issue.html_url}.`);
}

