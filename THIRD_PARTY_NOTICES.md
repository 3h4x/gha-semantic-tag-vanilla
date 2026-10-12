# Third-party notices

This action contains no third-party code at runtime, but parts of `src/` are
ports (rewritten by hand, behaviour kept) of the following packages. Their
licenses require this notice.

| Package | Version | License | Copyright | Ported into |
|---|---|---|---|---|
| semantic-release | 25.0.9 | MIT | Copyright (c) 2017 Contributors | `src/run.mjs`, `src/version.mjs`, `src/git.mjs` |
| @semantic-release/commit-analyzer | 13.0.1 | MIT | Copyright (c) 2017 Pierre-Denis Vanduynslager | `src/analyze.mjs` |
| @semantic-release/release-notes-generator | 14.1.1 | MIT | Copyright (c) 2017 Pierre-Denis Vanduynslager | `src/notes.mjs` |
| @semantic-release/npm | 13.2.0 | MIT | Copyright (c) 2017 Contributors | `src/npm.mjs` |
| @semantic-release/github | 12.0.10 | MIT | Copyright (c) 2017 Contributors | `src/run.mjs`, `src/comments.mjs` (comment texts verbatim) |
| conventional-commits-parser | 6.4.0 | MIT | Copyright © conventional-changelog team | `src/parser.mjs` |
| conventional-commits-filter | 5.0.0 | MIT | Copyright (c) 2015 Steve Mao | `src/parser.mjs` (`filterReverted`) |
| conventional-changelog-writer | 8.4.0 | MIT | Copyright © conventional-changelog team | `src/notes.mjs` |
| conventional-changelog-angular | 8.3.1 | ISC | Copyright © conventional-changelog team | `src/parser.mjs`, `src/notes.mjs` |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
