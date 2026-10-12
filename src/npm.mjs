// The @semantic-release/npm steps (verify, prepare, publish) on the npm CLI
// that is already on the runner.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReleaseError } from './config.mjs';

export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

const normalizeUrl = (url) => url.replace(/\/+$/, '').toLowerCase();

export function readPackage(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) throw new ReleaseError('ENOPKG', 'Missing package.json file.', `A package.json file at the root of your project is required to release on npm.`);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (!pkg.name) throw new ReleaseError('ENOPKGNAME', 'Missing name property in package.json.', 'The package.json\'s name property is required in order to publish a package to the npm registry.');
  return pkg;
}

// Flat key=value view of the project's npmrc (the user config when set).
function readNpmrc(dir, env) {
  const file = env.NPM_CONFIG_USERCONFIG || join(dir, '.npmrc');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return { text, values };
}

export function getRegistry(pkg, dir, env) {
  if (pkg.publishConfig?.registry) return pkg.publishConfig.registry;
  if (env.NPM_CONFIG_REGISTRY) return env.NPM_CONFIG_REGISTRY;
  const { values } = readNpmrc(dir, env);
  const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0] : null;
  return (scope && values[`${scope}:registry`]) || values.registry || OFFICIAL_REGISTRY;
}

// "https://npm.pkg.github.com" -> "//npm.pkg.github.com/"
export function nerfDart(registry) {
  const url = new URL(registry);
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${path}`;
}

export function createNpm({ dir, env, log, exec = execFileSync }) {
  const run = (args, cwd = dir) => exec('npm', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let npmrcPath = null;

  function shouldPublish(options, pkg) {
    return options.npmPublish !== false && pkg.private !== true;
  }

  // Writes the temporary userconfig every npm call uses, with the token.
  function setAuth(registry) {
    const { text, values } = readNpmrc(dir, env);
    const nerf = nerfDart(registry);
    const hasAuth = Object.keys(values).some((k) => k.startsWith(nerf) && /:(_authToken|_auth|_password)$/.test(k));
    npmrcPath = join(mkdtempSync(join(tmpdir(), 'gstv-npmrc-')), '.npmrc');
    if (hasAuth) {
      writeFileSync(npmrcPath, text);
      return;
    }
    if (!env.NPM_TOKEN) {
      throw new ReleaseError('ENONPMTOKEN', 'No npm token specified.', `An npm token must be created and set in the NPM_TOKEN environment variable to publish to ${registry}.`);
    }
    writeFileSync(npmrcPath, `${text ? `${text}\n` : ''}${nerf}:_authToken = \${NPM_TOKEN}`);
    log(`Wrote NPM_TOKEN to ${npmrcPath}`);
  }

  return {
    readPackage: () => readPackage(dir),
    shouldPublish,
    verify(options) {
      const pkg = readPackage(dir);
      if (!shouldPublish(options, pkg)) return;
      const registry = getRegistry(pkg, dir, env);
      log(`Verify authentication for registry ${registry}`);
      setAuth(registry);
      if (normalizeUrl(registry) === normalizeUrl(OFFICIAL_REGISTRY)) {
        try {
          run(['whoami', '--userconfig', npmrcPath, '--registry', registry]);
        } catch {
          throw new ReleaseError('EINVALIDNPMTOKEN', `Invalid npm token.`, `The npm token configured in the NPM_TOKEN environment variable must be a valid token allowing to publish to the registry ${registry}.`);
        }
      }
    },
    prepare(version, cwd = dir) {
      log(`Write version ${version} to package.json in ${cwd}`);
      const args = ['version', version, '--no-git-tag-version', '--allow-same-version'];
      run(npmrcPath ? [...args, '--userconfig', npmrcPath] : args, cwd);
    },
    // Returns the release info semantic-release reports, or false when skipped.
    publish(options, version, cwd = dir) {
      const pkg = readPackage(cwd);
      if (!shouldPublish(options, pkg)) {
        log(`Skip publishing to npm registry as ${options.npmPublish === false ? 'npmPublish' : "package.json's private property"} is ${options.npmPublish !== false}`);
        return false;
      }
      const registry = getRegistry(pkg, cwd, env);
      log(`Publishing version ${version} to npm registry on dist-tag latest`);
      run(['publish', cwd, '--userconfig', npmrcPath, '--tag', 'latest', '--registry', registry], cwd);
      log(`Published ${pkg.name}@${version} to dist-tag @latest on ${registry}`);
      return {
        name: 'npm package (@latest dist-tag)',
        url: normalizeUrl(registry) === normalizeUrl(OFFICIAL_REGISTRY) ? `https://www.npmjs.com/package/${pkg.name}/v/${version}` : undefined,
      };
    },
    versionExists(version) {
      const pkg = readPackage(dir);
      const registry = getRegistry(pkg, dir, env);
      try {
        return run(['view', `${pkg.name}@${version}`, 'version', '--userconfig', npmrcPath, '--registry', registry]).trim() !== '';
      } catch (error) {
        if (/E404|404 Not Found|is not in this registry/.test(String(error.stderr || error.message))) return false;
        throw error;
      }
    },
  };
}
