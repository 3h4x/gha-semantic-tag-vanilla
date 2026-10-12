// Tags and versions: the parts of semantic-release's get-tags, get-last-release
// and get-next-version that apply to a single release branch, with the small
// slice of `semver` they need.

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const FIRST_RELEASE = '1.0.0';

// semver.valid(semver.clean(v)): clean trims and strips a leading `=` / `v`.
export function parseVersion(raw) {
  const cleaned = String(raw).trim().replace(/^[=v]+/, '');
  const m = SEMVER.exec(cleaned);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || null };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return 0;
}

export function increment(version, type) {
  const { major, minor, patch } = parseVersion(version);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unsupported release type: ${type}`);
}

// tagFormat is a lodash template; only the `${version}` interpolation is
// supported (config.mjs enforces it).
export function makeTag(tagFormat, version) {
  return tagFormat.split('${version}').join(version);
}

export function tagRegExp(tagFormat) {
  const [before, after] = tagFormat.split('${version}');
  const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  // Like semantic-release: anchored at the start only.
  return new RegExp(`^${esc(before)}(.+)${esc(after)}`);
}

// Release tags reachable from the branch: [{ gitTag, version }].
export function releaseTags(tagNames, tagFormat) {
  const re = tagRegExp(tagFormat);
  const tags = [];
  for (const gitTag of tagNames) {
    const m = gitTag.match(re);
    if (m && parseVersion(m[1])) tags.push({ gitTag, version: m[1] });
  }
  return tags;
}

// Highest non-prerelease tag, optionally only those lower than `before`.
export function lastRelease(tags, { before } = {}) {
  const candidates = tags
    .filter(({ version }) => !parseVersion(version).prerelease)
    .filter(({ version }) => before === undefined || compareVersions(version, before) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] || null;
}

export function nextVersion(last, releaseType) {
  return last ? increment(last.version, releaseType) : FIRST_RELEASE;
}
