// Minimal GitHub REST client on the global fetch.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createGitHub({ token, owner, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch, retryDelayMs = 1000 }) {
  const base = apiUrl.replace(/\/$/, '');

  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'gha-semantic-tag-vanilla',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < 3) { await sleep(retryDelayMs * attempt); continue; }
        throw new GitHubError(0, `${method} ${path} failed: ${error.message}${error.cause ? ` (${error.cause.message || error.cause})` : ''}`);
      }
      const retryable = response.status === 429 || response.status >= 500
        || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      if (retryable && attempt < 3) { await sleep(retryDelayMs * attempt); continue; }
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new GitHubError(response.status, `${method} ${path} returned ${response.status}: ${data?.message || text}`);
      }
      return { data, link: response.headers.get('link') };
    }
  }

  async function paginate(path) {
    const items = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next) {
      const { data, link } = await request('GET', next);
      items.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(link || '')?.[1] || null;
    }
    return items;
  }

  const orNull = async (promise) => {
    try {
      return (await promise).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };

  const r = `/repos/${owner}/${repo}`;
  return {
    owner,
    repo,
    request,
    getRepo: async () => (await request('GET', r)).data,
    getReleaseByTag: (tag) => orNull(request('GET', `${r}/releases/tags/${encodeURIComponent(tag)}`)),
    createRelease: async (release) => (await request('POST', `${r}/releases`, release)).data,
    pullsForCommit: (sha) => paginate(`${r}/commits/${sha}/pulls`),
    pullCommits: (number) => paginate(`${r}/pulls/${number}/commits`),
    getPull: async (number) => (await request('GET', `${r}/pulls/${number}`)).data,
    getIssue: (number) => orNull(request('GET', `${r}/issues/${number}`)),
    comment: async (number, body) => (await request('POST', `${r}/issues/${number}/comments`, { body })).data,
    addLabels: async (number, labels) => (await request('POST', `${r}/issues/${number}/labels`, { labels })).data,
    openIssuesWithLabel: (label) => paginate(`${r}/issues?state=open&labels=${encodeURIComponent(label)}`),
    closeIssue: async (number) => (await request('PATCH', `${r}/issues/${number}`, { state: 'closed' })).data,
    createIssue: async (issue) => (await request('POST', `${r}/issues`, issue)).data,
  };
}
