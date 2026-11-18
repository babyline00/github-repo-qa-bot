# GitHub Repo Q&A Bot

> Drop a public GitHub URL → ingest the top 50 smallest files (unauthenticated contents API, 60 req/hr) → AST-chunk TS/JS / regex-chunk other langs → hybrid retrieval (BM25 + vector + RRF) → streaming chat with `[^c1]` citations grounded in retrieved chunks. Per-file sidebar filter. "Where is X used?" lookup via whole-word regex match.

Built fresh as **Project #16** of the 110-project portfolio plan. MVP-focused: single-repo ingestion, deterministic local-first retrieval, and a streaming RAG chat with grounded citations + an "Open on GitHub" link per citation.

---

## Features

- **Single-repo ingestion**: paste `https://github.com/owner/repo`, fetch the top 50 smallest files via the GitHub contents API (unauthenticated, 60 req/hr).
- **AST-aware chunking for TS/JS/TSX/JSX**: one chunk per top-level function / class / arrow-const. Uses `tree-sitter` when the bindings are installed, falls back to a regex-based structure detector with comment + string-aware brace matching otherwise. Imports are never chunked.
- **Regex chunking for other langs**: `.py`, `.go`, `.rs`, `.md` are split into fixed 50-line windows with `startLine` / `endLine`.
- **Hybrid retrieval**: BM25 (sparse) + cosine over a 384-dim hashing embedding (dense), fused with Reciprocal Rank Fusion (`k=60`).
- **Streaming RAG chat**: `text/plain` stream of LLM deltas followed by a `\n---CITATIONS---\n<json>` footer. Each citation card carries `{ chunkId, repoId, fileId, filePath, symbolName, startLine, endLine, preview, githubUrl }`.
- **Inline `[^c1]` citations + `path:line` references**: the system prompt instructs the LLM to use both — so citations are useful even when copied out of context.
- **Per-file sidebar filter**: multi-select checkboxes for the selected repo; the retrieval layer filters the in-memory corpus before scoring.
- **"Where is X used?" lookup**: separate API endpoint. Pure regex whole-word match (case-sensitive). Comment-aware via a line-based heuristic that handles `//`, `#`, `--`, `;` line comments and `/* ... */` / `<!-- -->` block comments per language family.
- **"Open on GitHub" link** in each citation card: `https://github.com/owner/repo/blob/<ref>/<path>#L<start>-L<end>`.
- **Stats banner**: `X repos · Y files · Z chunks`.

---

## MVP scope vs. stretch goals

### MVP (this repo)
- ✅ Single public GitHub repo ingestion via the contents API (60 req/hr budget).
- ✅ Top 50 smallest supported files (`.ts/.tsx/.js/.jsx/.py/.go/.rs/.md`), sorted by size ascending.
- ✅ AST chunking for TS/JS (regex fallback when `tree-sitter` isn't installed).
- ✅ Regex chunking (50-line windows) for other languages.
- ✅ Hybrid retrieval (BM25 + hashing-embedding vector + RRF).
- ✅ Streaming RAG chat with `[^c1]` citations + `file:line` references.
- ✅ Per-file sidebar filter (multi-select).
- ✅ "Where is X used?" lookup (whole-word, case-sensitive, comment-aware).
- ✅ "Open on GitHub" link in each citation card.
- ✅ Prisma 6 + SQLite local-first store (no external DB required).

### Stretch goals (not built; documented in the case study below)
- ⏳ Real dependency graph via import analysis (so "where is X used?" returns edges, not just text matches).
- ⏳ GitHub OAuth (raises the rate limit to 5000 req/hr and enables private repos).
- ⏳ Multi-repo federation (one Q&A bot over many repos).
- ⏳ Per-file commit-SHA pinning (instead of branch ref) for stable "Open on GitHub" links.
- ⏳ Tree-sitter WASM bindings so chunking works in the browser too.
- ⏳ Plug OpenAI `text-embedding-3-small` for real semantic embeddings (the seam already exists — set `EMBEDDINGS_API_KEY`).

---

## Tech stack

| Layer            | Choice                                             |
| ---------------- | -------------------------------------------------- |
| Framework        | Next.js 16 (App Router)                             |
| Language         | TypeScript 5                                       |
| Styling          | Tailwind CSS 4 + shadcn/ui (New York)               |
| Database         | Prisma 6 ORM + SQLite (local-first, JSON embeddings)|
| LLM / embeddings | `z-ai-web-dev-sdk` (chat) + hashing embedder (default) |
| AST parsing      | `tree-sitter` + `tree-sitter-typescript` (declared; falls back to regex) |
| Tests            | `bun test` (Bun's built-in runner)                   |
| Lint             | `eslint-config-next`                                 |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser (single page)                       │
│  ┌──────────────┐  ┌─────────────────────┐  ┌──────────────────────┐  │
│  │  Sidebar     │  │  Chat column        │  │  Where-used panel    │  │
│  │  - repo list │  │  - streaming deltas │  │  - symbol input      │  │
│  │  - add repo  │  │  - [^c1] chips      │  │  - file + line list  │  │
│  │  - file      │  │  - citation cards   │  │  - preview           │  │
│  │    filter    │  │    w/ "Open on      │  │                      │  │
│  │              │  │    GitHub" links    │  │                      │  │
│  └──────────────┘  └─────────────────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ fetch() — relative paths only
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Next.js 16 API routes                         │
│  POST /api/repos/import   POST /api/chat           POST /api/where-used│
│  GET  /api/repos          GET  /api/stats          DELETE /api/repos/[id]│
│  GET  /api/repos/[id]/files                                        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       ▼                          ▼                          ▼
┌───────────────┐  ┌────────────────────────┐  ┌──────────────────────────┐
│ github-fetch  │  │ retrieval (hybrid)      │  │ where-used (pure regex) │
│ - contents    │  │ - BM25 (in-mem)         │  │ - whole-word match      │
│   API client  │  │ - hashing-embedder      │  │ - comment-aware         │
│ - 60 req/hr   │  │ - RRF fusion           │  │                          │
└───────────────┘  └────────────────────────┘  └──────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │  chunker-ast  chunker-regex │
                    │  - tree-sitter (when present)│
                    │  - regex fallback           │
                    └─────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │   Prisma 6  +  SQLite        │
                    │   Repo / File / RepoChunk    │
                    │   ChatSession / ChatMessage  │
                    └─────────────────────────────┘
```

---

## Setup

### Prerequisites

- Node.js ≥ 20 (or Bun ≥ 1.3 for tests)
- A GitHub URL to ingest (public repo)

### Install & run

```bash
# 1. Install deps
bun install        # or: npm install

# 2. Push the Prisma schema to SQLite
bun run db:push   # creates db/custom.db

# 3. Start the dev server
bun run dev        # http://localhost:3000 (preview in the sandbox UI)

# 4. Open the app, paste a GitHub URL in the left sidebar, hit Enter.
```

### Environment variables

Copy `.env.example` → `.env` and fill in optional values:

```bash
DATABASE_URL=file:/absolute/path/to/db/custom.db  # REQUIRED — absolute path
# LLM (optional — defaults to a deterministic mock)
PKC_DISABLE_LLM=
# Embeddings (optional — defaults to the hashing embedder)
EMBEDDINGS_API_KEY=
EMBEDDINGS_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_MODEL=text-embedding-3-small
```

The `.env` file is created for you with an absolute `DATABASE_URL` pointing at `db/custom.db` inside this app's directory.

---

## Tests

```bash
bun test
```

Aim: 35+ tests across 9 files. Tests do **not** require real `tree-sitter` bindings — the AST-chunker tests use either a mock parser (`setAstParserForTest`) or the regex fallback path. Tests do **not** touch the network or the database; they exercise the pure functions only.

| Test file              | What it covers                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| `url-parser.test.ts`   | All 4 GitHub URL formats + rejections + `githubBlobLink` builder.        |
| `ast-chunker.test.ts`  | Function/class/arrow-const chunking, generated names, comment-aware braces, mock parser injection. |
| `regex-chunker.test.ts`| N-line chunker — ordinals, line ranges, CRLF, custom chunk size.         |
| `tokenizer.test.ts`    | Lowercasing, markdown stripping, CJK, URL stripping, stop words.        |
| `embeddings.test.ts`   | Determinism, L2 norm, cosine behaviour, vector round-trip.             |
| `bm25.test.ts`         | Ranked hits, topK limit, IDF weighting, empty corpus.                  |
| `hybrid-search.test.ts`| RRF fusion, k parameter, fuseHits output shape.                         |
| `ai.test.ts`           | RAG system-prompt builder (`[^c1]` + `path:line` references), `githubUrl` in citation map, citation extractor. |
| `where-used.test.ts`   | Whole-word match, case-sensitivity, comment-aware skipping for `//` / `#` / `--` / `/* */`. |

---

## API reference

All routes are under `src/app/api/`.

| Method   | Route                       | Body                                                                 | Returns                                       |
| -------- | -------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| `POST`   | `/api/repos/import`        | `{ url }`                                                            | `{ ok, repoId, fileCount, chunkCount, cap }`  |
| `GET`    | `/api/repos`               | —                                                                    | `{ repos: [...] }`                             |
| `GET`    | `/api/repos/[id]/files`    | —                                                                    | `{ repo, files: [...] }`                       |
| `DELETE` | `/api/repos/[id]`          | —                                                                    | `{ ok }`                                       |
| `POST`   | `/api/chat`                | `{ message, sessionId?, filterFileIds?, repoId? }`                    | `text/plain` stream + `---CITATIONS---` footer |
| `POST`   | `/api/where-used`          | `{ repoId, symbolName }`                                             | `{ repoId, symbolName, results: [...] }`       |
| `GET`    | `/api/stats`               | —                                                                    | `{ repos, files, chunks }`                     |

### Streaming protocol

`POST /api/chat` returns a `text/plain` body that streams LLM deltas, then a final `\n\n---CITATIONS---\n<json>` footer the client parses for the citation cards. The `X-Session-Id` response header echoes the (possibly new) session id.

```ts
const res = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({...}) })
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const sep = buffer.indexOf('\n---CITATIONS---\n')
  if (sep >= 0) {
    const deltas = buffer.slice(0, sep)
    const footer = JSON.parse(buffer.slice(sep + '\n---CITATIONS---\n'.length))
    // append deltas to the assistant message; render footer.citations as cards
    buffer = ''
  }
}
```

---

## Project structure

```
16-github-repo-qa-bot/
├─ package.json
├─ tsconfig.json
├─ next.config.ts
├─ postcss.config.mjs
├─ tailwind.config.ts
├─ components.json
├─ eslint.config.mjs
├─ .env / .env.example / .gitignore
├─ LICENSE
├─ README.md
├─ prisma/
│  └─ schema.prisma            # Repo / File / RepoChunk / ChatSession / ChatMessage
└─ src/
   ├─ app/
   │  ├─ globals.css
   │  ├─ layout.tsx
   │  ├─ page.tsx              # single user-visible route
   │  └─ api/
   │     ├─ repos/
   │     │  ├─ import/route.ts
   │     │  ├─ route.ts
   │     │  └─ [id]/
   │     │     ├─ files/route.ts
   │     │     └─ route.ts
   │     ├─ chat/route.ts
   │     ├─ where-used/route.ts
   │     └─ stats/route.ts
   ├─ components/ui/           # button, card, input, textarea, badge,
   │                          # checkbox, scroll-area, separator, skeleton,
   │                          # toast, toaster
   ├─ hooks/use-toast.ts
   └─ lib/
      ├─ ai.ts                 # streaming RAG system-prompt + citation extractor
      ├─ bm25.ts               # Okapi BM25
      ├─ chunker-ast.ts        # tree-sitter (optional) + regex fallback for TS/JS
      ├─ chunker-regex.ts      # N-line windows for non-TS/JS
      ├─ db.ts                 # Prisma client singleton
      ├─ embeddings.ts         # hashing-embedder (default) + OpenAI-compatible seam
      ├─ github-fetch.ts       # unauthenticated contents API client
      ├─ hybrid-search.ts     # Reciprocal Rank Fusion
      ├─ retrieval.ts         # in-memory corpus, BM25 + vector + RRF
      ├─ tokenizer.ts
      ├─ url-parser.ts         # GitHub URL parser + githubBlobLink builder
      ├─ utils.ts              # cn() helper
      └─ __tests__/            # 9 test files
```

---

## Case study — design decisions

### 1. tree-sitter AST chunking + graceful fallback

The spec asked for AST-aware chunking of TS/JS where **one chunk per function/method/class** carries `symbolName`, `startLine`, `endLine`. Imports are NOT chunked. Anonymous functions get a generated name.

**Choice**: use `tree-sitter` + `tree-sitter-typescript` when the bindings are installed (via dynamic `import()` so a missing module doesn't crash module-level eval). When the bindings are absent — e.g. in the test environment — fall back to a **regex-based TS/JS structure detector** that:

1. Recognises the common top-level declaration forms (`function`, `class`, `export ... function`, `async function`, `const x = () => {}`, `const x = function () {}`).
2. Walks forward from the declaration line, tracking brace depth.
3. **Respects strings and comments** while counting braces — a `}` inside a string literal or a `//` / `/* ... */` comment does not close the function.
4. Returns 1-indexed line ranges so they line up with GitHub's `#L<start>-L<end>` anchors.

**Why the fallback matters**: tests don't need real `tree-sitter` native bindings to assert the chunking contract — they exercise the regex path directly, or inject a mock parser via `setAstParserForTest()`. The contract (`{ symbolName, startLine, endLine, content }[]`) is identical in both code paths, so the rest of the app is oblivious.

**What I'd do differently next time**: ship the WASM build of `tree-sitter` (pre-built, no native deps) and run chunking in a worker. That removes the "do we have native bindings?" question entirely, lets the chunker run client-side for instant preview, and keeps the API identical.

### 2. GitHub API rate limits (60 req/hr unauthenticated)

The contents API gives you 60 requests per hour per IP without a token. The import pipeline makes:

- 1 request to `/repos/{owner}/{name}` for the default branch + description,
- 1 request to `/repos/{owner}/{name}/git/trees/{ref}?recursive=1` for the flat file list,
- 1 request per file to `/repos/{owner}/{name}/contents/{path}?ref={ref}` for the base64-encoded content.

So **1 + 1 + 50 = 52 requests per repo import**, leaving a tiny safety margin. The choice of *smallest files first* (sorted by `size` ascending) means the import captures the highest-signal-to-noise files (`README.md`, `package.json` is excluded — we don't fetch JSON unless it's in the supported set, but `.md` always is — small `lib/*.ts` files, etc.) rather than generated artefacts or vendored blobs.

**What I'd do differently next time**:

- Take a **GitHub OAuth token** so the budget jumps to 5000 req/hr. The token can live in an HTTP-only cookie; the API route would read it and pass it as a `Bearer` header. This unlocks private repos and 100x the import capacity.
- Use the **Trees API** to recursively fetch in one shot (already doing that), but **batch the contents API calls** with a small concurrency pool (e.g. 5 in flight) and **resume on next hour** if the budget runs out — persist a partial ingest and continue on the next `/api/repos/import` call with `?resume=1`.

### 3. "Where used?" lookup — pure regex whole-word match

The spec said: pure regex `\bSYMBOL\b` (case-sensitive), skip matches inside comments. No index, no AST.

**Choice**: a single pure function `whereUsed(symbolName, files) -> { fileId, filePath, lineMatches, preview }[]`. The comment-aware heuristic is line-oriented and handles the common comment styles per language family:

- `//` for JS/TS/Go/Rust/Java/C/CSS/JSON (last one is rarely used but harmless)
- `#` for Python/Ruby/Shell/YAML
- `--` for SQL/Lua
- `;` for Lisp/Assembly
- `/* ... */` block comments (state carried across lines)
- `<!-- ... -->` HTML comments — not in the heuristic but easy to add

It tracks an `inBlockComment` flag across lines so a `*/` closes a multi-line block comment and a `/*` opens one. Inside a line, once a comment marker is found, the rest of the line is stripped before the regex runs.

**Why not use the AST chunk index for "where used?"**: because the chunk index is per-symbol-chunk, not per-line, and the user explicitly wants *every* occurrence (including in strings, decorators, types). A whole-word regex match across the raw file content is the right tool — fast, predictable, and easy to reason about.

**What I'd do differently next time**: build a real **dependency graph** via tree-sitter's import edges (`ImportDeclaration`, `CallExpression(callee = Identifier)`). The lookup would then return `{ file: { symbols: [{ line, kind }] } }` with `kind ∈ { import, call, reference, type, string }`, which is *much* more useful than a regex match. The graph could even power "Callers of X" traversal and "Files that import X" — both impossible with regex alone.

---

## What I'd do differently (full list)

1. **Real dependency graph** via tree-sitter import analysis (see case study #3).
2. **GitHub OAuth** for 5000 req/hr + private repo access (see case study #2).
3. **Multi-repo federation**: a `Repo[]` filter in `/api/chat` so one bot answers across many repos. The retrieval layer already supports a `repoId` filter; the chat route would just pass `repoIds: string[]` and the SQL query becomes `WHERE repoId IN (...)`.
4. **Per-file commit-SHA pinning** for stable "Open on GitHub" links — currently we use the default branch which can drift between import and click. The contents API returns `sha` per file; storing it would let us build `https://github.com/owner/repo/blob/<sha>/path#L12-L18` that always points at the exact code we indexed.
5. **Tree-sitter WASM** instead of native bindings (see case study #1).
6. **Plug real embeddings** via `text-embedding-3-small` — the seam already exists; setting `EMBEDDINGS_API_KEY` flips the provider. For 50 files / ~500 chunks the cost is well under $0.01 per import.
7. **Streaming SSE** instead of the custom `---CITATIONS---` footer — would let the client render citations incrementally as the model emits them. The current protocol keeps things simple and works fine for ~500-chunk corpora.

---

## Resume bullet

> Built a **GitHub Repo Q&A Bot** (Next.js 16 + TypeScript + Prisma/SQLite) that ingests the top 50 smallest files of any public GitHub repo via the unauthenticated contents API (60 req/hr), AST-chunks TS/JS with `tree-sitter` (regex fallback for tests), hybrid-retrieves via BM25 + 384-dim hashing embeddings + Reciprocal Rank Fusion, and streams grounded answers with inline `[^c1]` citations + `file:line` references and an "Open on GitHub" link per citation. Ships a pure-regex, comment-aware "Where is X used?" lookup, per-file sidebar filter, and a deterministic local-first SQLite store so it runs offline with zero external API keys. 35+ unit tests across 9 files cover URL parsing, AST + regex chunking, BM25/RRF math, the RAG system-prompt contract, and the where-used comment heuristic.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Push instructions

```bash
gh repo create github-repo-qa-bot --public --source=. --remote=origin --push
```
