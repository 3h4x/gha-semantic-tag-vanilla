// GitHub Actions entry point: wires real git/GitHub/npm into run() and writes
// the step outputs. No @actions/core: outputs go straight to $GITHUB_OUTPUT.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createGit } from './git.mjs';
import { createGitHub } from './github.mjs';
import { createNpm } from './npm.mjs';
import { run } from './run.mjs';
import { parseVersion } from './version.mjs';

const env = process.env;
const cwd = env['INPUT_WORKING-DIRECTORY'] || env.GITHUB_WORKSPACE || process.cwd();
const dryRun = /^true$/i.test(env['INPUT_DRY-RUN'] || 'false');

// Environment variables win, as with semantic-release (a workflow migrating to
// this action keeps its `env:` block); the inputs are the fallback.
if (!env.GITHUB_TOKEN && env['INPUT_GITHUB-TOKEN']) env.GITHUB_TOKEN = env['INPUT_GITHUB-TOKEN'];
if (!env.NPM_TOKEN && env['INPUT_NPM-TOKEN']) env.NPM_TOKEN = env['INPUT_NPM-TOKEN'];

const secrets = [env.GH_TOKEN, env.GITHUB_TOKEN, env.NPM_TOKEN].filter(Boolean);
for (const secret of secrets) process.stdout.write(`::add-mask::${secret}\n`);
const scrub = (text) => secrets.reduce((s, secret) => s.split(secret).join('[secure]'), String(text));

const log = (message) => process.stdout.write(`${scrub(message)}\n`);
const warn = (message) => process.stdout.write(`::warning::${scrub(message).replace(/\n/g, '%0A')}\n`);

function setOutput(name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const text = String(value ?? '');
  const delimiter = `gstv_${randomUUID()}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

try {
  const result = await run({
    cwd,
    env,
    dryRun,
    git: createGit({ cwd, secrets }),
    createGitHub,
    npm: createNpm({ dir: cwd, env, log }),
    log,
    warn,
  });

  const v = result.version ? parseVersion(result.version) : null;
  setOutput('new_release_published', result.published ? 'true' : 'false');
  setOutput('new_release_version', result.version);
  setOutput('new_release_major_version', v?.major);
  setOutput('new_release_minor_version', v?.minor);
  setOutput('new_release_patch_version', v?.patch);
  setOutput('new_release_git_tag', result.gitTag);
  setOutput('new_release_git_head', result.gitHead);
  setOutput('new_release_notes', result.notes);
  setOutput('new_release_type', result.releaseType);
  setOutput('last_release_version', result.lastRelease?.version);
  setOutput('last_release_git_tag', result.lastRelease?.gitTag);
  setOutput('recovered_release_git_tag', result.recovered);

  if (env.GITHUB_STEP_SUMMARY) {
    const summary = result.version
      ? `### ${dryRun ? 'Dry run: would release' : 'Released'} ${result.gitTag}\n\n${result.notes || ''}\n`
      : '### No release\n\nNo commit since the last release triggers one.\n';
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  }
} catch (error) {
  process.stdout.write(`::error title=${scrub(error.code || 'Release failed')}::${scrub(error.message).replace(/\n/g, '%0A')}\n`);
  if (error.details) log(error.details);
  process.exitCode = 1;
}
