// Conventional commit message parser.
//
// A port of conventional-commits-parser 6.4.0 (CommitParser) configured the way
// semantic-release 25 configures it: the angular preset's parser options
// (conventional-changelog-angular 8.3.1) merged over the GitHub host config of
// @semantic-release/release-notes-generator. Behaviour is kept line for line,
// quirks included, because both the version bump and the release notes are
// derived from what this returns. See THIRD_PARTY_NOTICES.md.

export const ANGULAR_PARSER_OPTIONS = {
  headerPattern: /^(\w*)(?:\((.*)\))?: (.*)$/,
  headerCorrespondence: ['type', 'scope', 'subject'],
  noteKeywords: ['BREAKING CHANGE'],
  revertPattern: /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w{7,40})\b/i,
  revertCorrespondence: ['header', 'hash'],
  fieldPattern: /^-(.*?)-$/,
  // GitHub host config from release-notes-generator (commit-analyzer uses the
  // parser defaults below instead; the difference only affects `references`,
  // which the analyzer never looks at).
  referenceActions: ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'],
  issuePrefixes: ['#', 'gh-'],
};

const NO_MATCH = /(?!.*)/;

function escape(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinOr(parts) {
  return parts
    .map((val) => (typeof val === 'string' ? escape(val.trim()) : val.source))
    .filter(Boolean)
    .join('|');
}

function getRegexes(options) {
  const notes = options.noteKeywords
    ? new RegExp(`^[\\s|*]*(${joinOr(options.noteKeywords)})[:\\s]+(.*)`, 'i')
    : NO_MATCH;
  const referenceParts = options.issuePrefixes
    ? new RegExp(`(?:.*?)??\\s*([\\w-\\.\\/]*?)??(${joinOr(options.issuePrefixes)})([\\w-]+)(?=\\s|$|[,;)\\]])`, 'gi')
    : NO_MATCH;
  let references = /()(.+)/gi;
  if (options.referenceActions) {
    const keywords = joinOr(options.referenceActions);
    references = new RegExp(`(${keywords})(?:\\s+(.*?))(?=(?:${keywords})|$)`, 'gi');
  }
  return {
    notes,
    referenceParts,
    references,
    mentions: /@([\w-]+)/g,
    url: /\b(?:https?):\/\/(?:www\.)?([-a-zA-Z0-9@:%_+.~#?&//=])+\b/,
  };
}

function trimNewLines(input) {
  const matches = input.match(/[^\r\n]/);
  if (typeof matches?.index !== 'number') return '';
  let lastIndex = input.length - 1;
  while (input[lastIndex] === '\r' || input[lastIndex] === '\n') lastIndex--;
  return input.substring(matches.index, lastIndex + 1);
}

function appendLine(src, line) {
  return src ? `${src}\n${line || ''}` : line || '';
}

function assignMatched(target, matches, correspondence) {
  for (let i = 0; i < correspondence.length; i++) {
    target[correspondence[i]] = matches[i + 1] || null;
  }
  return target;
}

export class CommitParser {
  constructor(options = ANGULAR_PARSER_OPTIONS) {
    this.options = options;
    this.regexes = getRegexes(options);
  }

  currentLine() { return this.lines[this.lineIndex]; }
  nextLine() { return this.lines[this.lineIndex++]; }
  isLineAvailable() { return this.lineIndex < this.lines.length; }

  parseReference(input, action) {
    const { regexes } = this;
    if (regexes.url.test(input)) return null;
    const matches = regexes.referenceParts.exec(input);
    if (!matches) return null;
    let [raw, repository = null, prefix, issue] = matches;
    let owner = null;
    if (repository) {
      const slash = repository.indexOf('/');
      if (slash !== -1) {
        owner = repository.slice(0, slash);
        repository = repository.slice(slash + 1);
      }
    }
    return { raw, action, owner, repository, prefix, issue };
  }

  parseReferences(input) {
    const regex = input.match(this.regexes.references) ? this.regexes.references : /()(.+)/gi;
    const references = [];
    for (;;) {
      const matches = regex.exec(input);
      if (!matches) break;
      const action = matches[1] || null;
      const sentence = matches[2] || '';
      for (;;) {
        const reference = this.parseReference(sentence, action);
        if (!reference) break;
        references.push(reference);
      }
    }
    return references;
  }

  parseHeader() {
    const { commit, options } = this;
    const header = commit.header ?? this.nextLine();
    if (header) {
      commit.header = header;
      const matches = header.match(options.headerPattern);
      if (matches) assignMatched(commit, matches, options.headerCorrespondence);
    }
  }

  parseMeta() {
    const { options, commit } = this;
    if (!options.fieldPattern || !this.isLineAvailable()) return false;
    let field = null;
    let parsed = false;
    while (this.isLineAvailable()) {
      const matches = this.currentLine().match(options.fieldPattern);
      if (matches) {
        field = matches[1] || null;
        this.nextLine();
        continue;
      }
      if (field) {
        parsed = true;
        commit[field] = appendLine(commit[field], this.currentLine());
        this.nextLine();
      } else {
        break;
      }
    }
    return parsed;
  }

  parseNotes() {
    const { regexes, commit } = this;
    if (!this.isLineAvailable()) return false;
    const matches = this.currentLine().match(regexes.notes);
    if (!matches) return false;
    const note = { title: matches[1], text: matches[2] };
    commit.notes.push(note);
    commit.footer = appendLine(commit.footer, this.currentLine());
    this.nextLine();
    while (this.isLineAvailable()) {
      if (this.parseMeta()) return true;
      if (this.parseNotes()) return true;
      const references = this.parseReferences(this.currentLine());
      if (references.length) commit.references.push(...references);
      else note.text = appendLine(note.text, this.currentLine());
      commit.footer = appendLine(commit.footer, this.currentLine());
      this.nextLine();
      if (references.length) break;
    }
    return true;
  }

  parseBodyAndFooter(isBody) {
    const { commit } = this;
    if (!this.isLineAvailable()) return isBody;
    const references = this.parseReferences(this.currentLine());
    const isStillBody = !references.length && isBody;
    if (isStillBody) {
      commit.body = appendLine(commit.body, this.currentLine());
    } else {
      commit.references.push(...references);
      commit.footer = appendLine(commit.footer, this.currentLine());
    }
    this.nextLine();
    return isStillBody;
  }

  parseMentions(input) {
    for (;;) {
      const matches = this.regexes.mentions.exec(input);
      if (!matches) break;
      this.commit.mentions.push(matches[1]);
    }
  }

  parseRevert(input) {
    const { options } = this;
    const matches = input.match(options.revertPattern);
    if (matches) this.commit.revert = assignMatched({}, matches, options.revertCorrespondence);
  }

  cleanup() {
    const { commit } = this;
    if (commit.body) commit.body = trimNewLines(commit.body);
    if (commit.footer) commit.footer = trimNewLines(commit.footer);
    for (const note of commit.notes) note.text = trimNewLines(note.text);
    const seen = new Set();
    commit.references = commit.references.filter((reference) => {
      const uid = `${reference.action} ${reference.raw}`.toLocaleLowerCase();
      if (seen.has(uid)) return false;
      seen.add(uid);
      return true;
    });
  }

  parse(input) {
    if (!input.trim()) throw new TypeError('Expected a raw commit');
    this.lines = trimNewLines(input).split(/\r?\n/).filter((line) => !line.match(/^\s*gpg:/));
    this.lineIndex = 0;
    this.commit = {
      merge: null, revert: null, header: null, body: null, footer: null,
      notes: [], mentions: [], references: [],
    };
    const { commit } = this;
    // The angular preset has no mergePattern, so a merge commit is parsed like
    // any other: its "Merge pull request ..." header matches no type.
    this.parseHeader();
    if (commit.header) commit.references = this.parseReferences(commit.header);
    let isBody = true;
    while (this.isLineAvailable()) {
      this.parseMeta();
      if (this.parseNotes()) isBody = false;
      if (!this.parseBodyAndFooter(isBody)) isBody = false;
    }
    this.parseMentions(input);
    this.parseRevert(input);
    this.cleanup();
    return commit;
  }
}

function isMatch(object, source) {
  for (const key in source) {
    let a = object[key];
    let b = source[key];
    if (typeof a === 'string') a = a.trim();
    if (typeof b === 'string') b = b.trim();
    if (a !== b) return false;
  }
  return true;
}

// conventional-commits-filter 5's filterRevertedCommitsSync: drops each
// "revert" commit together with the commit it reverts, when both are in range.
export function filterReverted(commits) {
  const hold = new Set();
  let holdReverts = 0;
  const out = [];
  for (const commit of commits) {
    let reverted = null;
    if (hold.size) {
      const raw = commit.raw || commit;
      for (const candidate of hold) {
        if (candidate.revert && isMatch(raw, candidate.revert)) { reverted = candidate; break; }
      }
    }
    if (reverted) {
      hold.delete(reverted);
      holdReverts--;
      continue;
    }
    if (commit.revert) {
      hold.add(commit);
      holdReverts++;
      continue;
    }
    if (holdReverts > 0) {
      hold.add(commit);
    } else {
      out.push(...hold, commit);
      hold.clear();
    }
  }
  out.push(...hold);
  return out;
}

// What both commit-analyzer and release-notes-generator do to the commit list:
// drop empty messages, parse, then drop revert pairs.
export function parseCommits(commits, parser = new CommitParser()) {
  return filterReverted(
    commits
      .filter(({ message }) => message.trim())
      .map((commit) => ({ ...commit, ...parser.parse(commit.message) })),
  );
}

// semantic-release core removes these before analysis only; they still appear
// in the release notes.
export function withoutSkipped(commits) {
  return commits.filter(({ message }) => !/\[skip\s+release]|\[release\s+skip]/i.test(message));
}
