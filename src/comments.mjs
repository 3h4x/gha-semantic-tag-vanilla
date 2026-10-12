// Texts posted by @semantic-release/github 12, kept word for word so issue and
// PR threads look the same before and after switching.

const HOME_URL = 'https://github.com/semantic-release/semantic-release';
const FAQ_URL = `${HOME_URL}/blob/master/docs/support/FAQ.md`;
const GET_HELP_URL = `${HOME_URL}#get-help`;
const USAGE_DOC_URL = `${HOME_URL}/blob/master/docs/usage/README.md`;
const NEW_ISSUE_URL = `${HOME_URL}/issues/new`;

export const ISSUE_ID = '<!-- semantic-release:github -->';
export const RELEASE_FAIL_LABEL = 'semantic-release';
export const RELEASE_NAME = 'GitHub release';

const linkify = (info) => (info.url ? `[${info.name}](${info.url})` : `\`${info.name}\``);

export function successComment(issue, releaseInfos, version) {
  const available = releaseInfos.length > 0
    ? `\n\nThe release is available on${releaseInfos.length === 1
      ? ` ${linkify(releaseInfos[0])}`
      : `:\n${releaseInfos.map((info) => `- ${linkify(info)}`).join('\n')}`}`
    : '';
  return `:tada: This ${issue.pull_request ? 'PR is included' : 'issue has been resolved'} in version ${version} :tada:${available}

Your **[semantic-release](${HOME_URL})** bot :package::rocket:`;
}

const formatError = (error) => `### ${error.message}

${error.details || "Unfortunately this error doesn't have any additional information."}`;

export function failComment(branch, errors) {
  return `## :rotating_light: The automated release from the \`${branch}\` branch failed. :rotating_light:

I recommend you give this issue a high priority, so other packages depending on you can benefit from your bug fixes and new features again.

You can find below the list of errors reported by **semantic-release**. Each one of them has to be resolved in order to automatically publish your package. I’m sure you can fix this 💪.

Errors are usually caused by a misconfiguration or an authentication problem. With each error reported below you will find explanation and guidance to help you to resolve it.

Once all the errors are resolved, **semantic-release** will release your package the next time you push a commit to the \`${branch}\` branch. You can also manually restart the failed CI job that runs **semantic-release**.

If you are not sure how to resolve this, here are some links that can help you:
- [Usage documentation](${USAGE_DOC_URL})
- [Frequently Asked Questions](${FAQ_URL})
- [Support channels](${GET_HELP_URL})

If those don’t help, or if this issue is reporting something you think isn’t right, you can always ask the humans behind **[semantic-release](${NEW_ISSUE_URL})**.

---

${errors.map(formatError).join('\n\n---\n\n')}

---

Good luck with your project ✨

Your **[semantic-release](${HOME_URL})** bot :package::rocket:`;
}

// issue-parser's "github" close actions, as @semantic-release/github uses
// them: keyword then #N, owner/repo#N or an issue/PR URL. Several references
// may follow one keyword ("fixes #1, #2 and #3").
const CLOSE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b:?\s+((?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)(?:(?:\s*,\s*|\s+and\s+|\s+)(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+))*)/gi;
const REF = /(?:([\w.-]+\/[\w.-]+)?#(\d+))|https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/gi;

export function closedIssueNumbers(text, owner, repo) {
  const numbers = [];
  if (!text) return numbers;
  for (const action of text.matchAll(CLOSE)) {
    for (const ref of action[1].matchAll(REF)) {
      const slug = ref[1] || ref[3];
      const number = Number.parseInt(ref[2] || ref[4], 10);
      if (!slug || slug.toLowerCase() === `${owner}/${repo}`.toLowerCase()) numbers.push(number);
    }
  }
  return numbers;
}
