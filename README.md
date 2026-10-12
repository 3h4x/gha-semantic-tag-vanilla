# gha-semantic-tag-vanilla

A drop-in replacement for `semantic-release` in GitHub Actions with **zero npm
dependencies**. It reads your existing `.releaserc`, computes the next version
from conventional commits, tags, publishes to npm, creates the GitHub Release
and comments on the released PRs and issues, exactly like semantic-release with
`@semantic-release/commit-analyzer`, `release-notes-generator`, `npm` and
`github`.

Why: semantic-release pulls in hundreds of packages, and every advisory in that
tree (handlebars via `conventional-changelog-writer`, for one) pages every repo
that uses it. This action is plain Node built-ins: no lockfile, no
`node_modules`, no bundle. The code in this repo is the code that runs.

## Usage

Replace the semantic-release step and drop its devDependencies. Keep `.releaserc`.

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    concurrency: release
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: release
        uses: 3h4x/gha-semantic-tag-vanilla@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}   # only with @semantic-release/npm
      - if: steps.release.outputs.new_release_published == 'true'
        run: echo "released ${{ steps.release.outputs.new_release_version }}"
```

Before:

```yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`node` and `npm` come with the runner; nothing is installed.

### Inputs

| Input | Default | |
|---|---|---|
| `dry-run` | `false` | Print the next version and notes; tag and publish nothing. |
| `github-token` | `${{ github.token }}` | Used when neither `GH_TOKEN` nor `GITHUB_TOKEN` is in the environment. |
| `npm-token` | | Used when `NPM_TOKEN` is not in the environment. |
| `working-directory` | workspace | Directory with `.releaserc` (and `package.json`). |

### Outputs

`new_release_published`, `new_release_version`, `new_release_major_version`,
`new_release_minor_version`, `new_release_patch_version`, `new_release_git_tag`,
`new_release_git_head`, `new_release_notes`, `new_release_type`,
`last_release_version`, `last_release_git_tag`, `recovered_release_git_tag`.
In a dry run `new_release_published` is `false` and the version outputs are
still set.

## What is reproduced

Checked by `test/parity.test.mjs` against the real plugins
(semantic-release 25.0.9) on hand-written edge cases and on every release in the
histories of [3h4x/mcp-http-tools](https://github.com/3h4x/mcp-http-tools) (52)
and [3h4x/tamtam](https://github.com/3h4x/tamtam) (818): same version, same notes,
byte for byte.

- **Config**: a JSON `.releaserc`: `branches` (one plain branch), `tagFormat`
  (`${version}` only), `repositoryUrl`, `plugins`, top-level `preset: "angular"`
  and `releaseRules`. No `.releaserc` means semantic-release's default plugins,
  releasing from `main` or `master`.
- **commit-analyzer**: angular preset, `releaseRules` (inline array; `type`,
  `scope`, `breaking`, `revert` and any parsed field; globs `*`, `?`, `{a,b}`,
  leading `!`), falling back to the default rules, `release: false`,
  `[skip release]` / `[release skip]`. As in the angular preset, `feat!:` is **not**
  a breaking change (the header does not parse); only a `BREAKING CHANGE:` footer is.
- **release-notes-generator**: angular preset notes: sections, sorting, compare
  and commit links, issue references, `@mentions`, BREAKING CHANGES, reverts
  cancelling out.
- **npm**: `npm version` without committing, `npm publish --tag latest` to
  `publishConfig.registry` / `NPM_CONFIG_REGISTRY` / `.npmrc` / npmjs, auth from
  an existing `.npmrc` or `NPM_TOKEN`, `npm whoami` check on npmjs, `npmPublish`
  and `private`.
- **github**: the release (`name` = tag, `make_latest`), success comments and the
  `released` label on PRs in the release and on issues they close, closing old
  failure issues, opening or commenting the failure issue (`failTitle`, `labels`,
  `assignees`, `releasedLabels`, `successComment: false`, `failComment: false`,
  `failCommentCondition: false` or `"<% return false; %>"`).
- **core**: skips pull_request events, other branches and a checkout behind its
  remote; unshallows a shallow clone; last release = highest tag reachable from
  HEAD; first release `1.0.0`; the per-tag `refs/notes/semantic-release-<tag>`
  note, so you can switch back at any time.

Anything else in `.releaserc` (other plugins such as `@semantic-release/git` or
`changelog`, prerelease or maintenance branches, channels, other presets,
templates, `assets`, JS config files) **fails the run before any side effect**,
naming the setting.

## Deliberate differences

- **Half-finished releases are repaired.** If the latest tag on the remote has no
  GitHub Release (a run died after pushing it), the next run publishes it first:
  GitHub Release, npm version if missing from the registry (from a worktree of
  the tag), comments. semantic-release would skip it forever.
- **A failed tag push leaves no local tag** behind.
- **Comment failures after a successful release are warnings**, not a failed job:
  the release exists either way.
- Only the new tag and its note are pushed, not every local tag.
- Issue references in PR bodies and commit messages are found by keyword
  (`close[sd]`, `fix(es|ed)`, `resolve[sd]` + `#N`, `owner/repo#N` or an issue
  URL); semantic-release uses the `issue-parser` package.

## Development

```bash
node --test 'test/*.test.mjs'
```

Regenerating the parity fixtures needs semantic-release, installed outside this
repo; see the header of `scripts/golden.mjs`.

Design: [docs/superpowers/specs/2026-10-12-gha-semantic-tag-vanilla-design.md](docs/superpowers/specs/2026-10-12-gha-semantic-tag-vanilla-design.md).

## License

MIT. Parts are ports of MIT-licensed semantic-release and conventional-changelog
code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
