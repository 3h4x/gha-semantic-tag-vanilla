# gha-semantic-tag-vanilla — design

Date: 2026-10-12
Status: draft, awaiting review

## Why

`semantic-release` drags a large npm tree into every repo that uses it. On 2026-10-11 two
critical Dependabot alerts (handlebars GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f) fired on
`3h4x/mcp-http-tools`, reached only through
`semantic-release -> @semantic-release/* -> conventional-changelog-writer@8 -> handlebars`.
The latest semantic-release (25.0.9) still pins `conventional-changelog-writer@^8`, so
upgrading it does not remove the dependency. The next CVE in that chain will page again.

This action replaces `pnpm exec semantic-release` with a GitHub Action that has **zero npm
dependencies**: nothing to lock, nothing for Dependabot to flag, and the code in the repo is
exactly the code that runs.

## Goal and success criteria

A drop-in, 1:1 replacement for how semantic-release is used today in:

| | `3h4x/mcp-http-tools` | `3h4x/tamtam` |
|---|---|---|
| branch | `main` | `master` |
| `releaseRules` | breaking→major, feat→minor, 9 types→patch | identical |
| release-notes-generator | default (angular) preset | same |
| npm | publishes to GitHub Packages (`publishConfig.registry`) | not used |
| github | `failCommentCondition: false` | defaults |

Migration in a consumer = replace the `pnpm exec semantic-release` step with
`uses: 3h4x/gha-semantic-tag-vanilla@v1`, delete the semantic-release devDependencies, keep
`.releaserc` unchanged.

Success means: for the git history of both repos, this action computes the **same next
version** and produces **the same release notes** as semantic-release, proven by golden-file
tests generated from real `semantic-release --dry-run` runs.

## Scope

Supported (exactly what the two consumers use):

1. **Config**: `.releaserc` (JSON) at the repo root. Keys: `branches` (array of plain branch
   names), `tagFormat` (default `v${version}`), `plugins`.
2. **`@semantic-release/commit-analyzer`** with the angular preset and optional
   `releaseRules` (rule keys `type`, `scope`, `breaking`, `revert`, `release`). Semantics match
   the original: custom rules are checked first, then the default rules
   (breaking→major, revert→patch, feat→minor, fix→patch, perf→patch); the highest release
   type across commits wins; `release: false` suppresses. Commits whose message contains
   `[skip release]` or `[release skip]` are ignored.
3. **`@semantic-release/release-notes-generator`** with the angular preset: header with
   compare link and date, sections Features / Bug Fixes / Performance Improvements / Reverts,
   BREAKING CHANGES notes, short-hash commit links, `#123` issue links. Rendered by a template
   written in plain JS — no handlebars.
4. **`@semantic-release/npm`**: sets `version` in `package.json` in the workspace (not
   committed, as the original), then `npm publish` to the registry from
   `publishConfig.registry` (or npmjs), authenticated with `NPM_TOKEN`. Skips publishing when
   `npmPublish: false` or `private: true`. Uses the `npm` CLI already on the runner.
5. **`@semantic-release/github`**:
   - creates the tag's GitHub Release with the generated notes;
   - success comment on every PR (and issues they close) whose commits are in the release,
     same wording as the original, and the `released` label;
   - on failure, opens/updates an issue labelled `semantic-release` like the original,
     unless `failCommentCondition` evaluates to false (only the literal
     `"<% return false; %>"` is recognised; any other template string is rejected).
6. **First release**: no previous tag → `1.0.0`.
7. **Outputs** (compatible with the popular `cycjimmy/semantic-release-action`):
   `new_release_published`, `new_release_version`, `new_release_major_version`,
   `new_release_minor_version`, `new_release_patch_version`, `new_release_notes`,
   `new_release_git_tag`, `last_release_version`.
8. **Input** `dry-run` (default `false`): compute and print version + notes, change nothing.

Out of scope — present in `.releaserc` ⇒ the action fails before doing anything, with a
message naming the key: `@semantic-release/git`, `@semantic-release/changelog`, any other
plugin, prerelease/maintenance branch objects, channels, presets other than angular,
`release.config.js` / `.releaserc.yml` / `package.json#release`.

## Approach

Plain JavaScript action, `runs.using: node24`, `main: src/index.mjs`. Only Node built-ins
(`node:child_process`, `node:fs`, `node:path`, global `fetch`). No `package.json`
dependencies, no `node_modules`, no bundler, no committed `dist/`. Outputs are written to
`$GITHUB_OUTPUT` / `$GITHUB_STEP_SUMMARY` directly instead of `@actions/core`.

Rejected: TypeScript + `ncc` bundle with `@actions/*` (dependencies come back, hidden inside
`dist/` where no scanner sees them — worse than today); forking semantic-release with a
swapped writer (keeps the whole tree).

## Modules

All modules except `index`, `git`, `github` and `npm` are pure functions.

| Module | Responsibility |
|---|---|
| `src/config.mjs` | Read + validate `.releaserc`, reject unsupported keys/plugins, return normalised config. |
| `src/commits.mjs` | Parse a commit message (angular: type, scope, subject, `!`, `BREAKING CHANGE:` footer, revert, issue refs). |
| `src/analyze.mjs` | Parsed commits + rules → `major` / `minor` / `patch` / `null`. |
| `src/version.mjs` | Pick the last release tag matching `tagFormat`, compute the next version. |
| `src/notes.mjs` | Render release notes markdown (angular preset format). |
| `src/git.mjs` | Thin `execFileSync('git', …)` wrapper: log, tags, create/push tag. |
| `src/github.mjs` | Thin REST wrapper on `fetch`: releases, PRs for a commit, comments, labels, issues. 3 retries with backoff on 429/5xx, none on other 4xx. |
| `src/npm.mjs` | Set `package.json` version, write `.npmrc` auth, run `npm publish`. |
| `src/index.mjs` | Orchestration, outputs, step summary. |

## Flow

Same order as semantic-release:

1. **Verify** (nothing changed yet): config valid; current branch is in `branches` (otherwise
   exit 0, no release); full history present (shallow clone ⇒ fail with "use fetch-depth: 0");
   token can push (`git push --dry-run` of a probe ref); npm token present when publishing.
2. **Recover** (see below).
3. **Analyze** commits since the last release tag; `null` ⇒ exit 0, `new_release_published=false`.
4. **Generate notes.**
5. **Prepare**: npm `version` bump in the workspace.
6. **Tag** `HEAD` and push the tag.
7. **Publish**: `npm publish`, then create the GitHub Release.
8. **Success**: PR/issue comments and labels. Failures here are warnings, the release stands.

On an error in steps 1–7 the action fails the job and (unless disabled) opens the failure issue.

## Recovery from a half-finished release (deliberate deviation)

semantic-release, re-run after a failure between tag push and publish, treats the pushed tag
as the last release and never publishes it — someone has to fix it by hand. This action, at
step 2, checks whether the latest release tag has a GitHub Release. If not, it finishes the
missing steps first: creates the release with the regenerated notes for that tag's range, and
if npm publishing is configured and that version is absent from the registry, publishes it.
Then it continues with step 3. Re-running the workflow is therefore always a safe repair.

Concurrent runs: pushing an existing tag fails, so nothing is overwritten. The README
recommends `concurrency: release` in the consumer workflow.

## Testing

1. **Unit** (`node --test`, no network, no git) for `config`, `commits`, `analyze`,
   `version`, `notes`: revert commits, merge commits, scopes with dashes, `!` and footer
   breaking changes, `[skip release]`, no tags, tags not matching `tagFormat`, custom rules
   falling through to defaults, `release: false`.
2. **Parity golden files**: run real `semantic-release --dry-run` (pinned version, once, in a
   throwaway directory) over chosen ranges of `mcp-http-tools` and `tamtam` history; store the
   computed version and notes as fixtures; tests assert identical output. A script
   regenerates them.
3. **End-to-end**: temp git repo with a bare remote and a fake GitHub API on `node:http`;
   covers no tags → 1.0.0, feat → 1.1.0, nothing releasable, dry-run, half-finished release
   recovery, failure issue, success comments.
4. **Dogfooding**: the repo releases itself with its own action and moves the major tag `v1`.

CI: `node --test` on push/PR, plus `actions/*` pinned by SHA (the only Dependabot surface).

## Rollout

1. `3h4x/mcp-http-tools`: swap the release step, remove the 5 semantic-release devDeps (and
   with them handlebars). Verify the next release publishes to GitHub Packages.
2. `3h4x/tamtam`: same, after the first good mcp-http-tools release.
