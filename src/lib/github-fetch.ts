/**
 * GitHub contents API client (unauthenticated, 60 req/hr).
 *
 * MVP scope: fetch the top 50 smallest files in a repo's default branch that
 * match a supported extension. We do this by:
 *   1. GET /repos/{owner}/{name}                  → default_branch, description
 *   2. GET /repos/{owner}/{name}/git/trees/{ref}?recursive=1  → flat file list
 *   3. Sort by size ascending, take first 50 matching the extension whitelist.
 *   4. For each file, GET /repos/{owner}/{name}/contents/{path}?ref={ref}
 *      (returns base64 content; we decode to UTF-8).
 *
 * That's 1 + 1 + 50 = 52 requests per repo — within the 60/hr unauthenticated
 * budget. For repos bigger than the budget, the importer simply processes
 * the first 50 and stops. No GitHub token is required.
 *
 * All network calls use `fetch`. The functions are split out so tests can
 * mock `fetchRepoTree` / `fetchFileContent` independently of the network.
 */

export interface GithubFileMeta {
  path: string
  size: number
}

export interface GithubFileContent extends GithubFileMeta {
  content: string
  language: string
}

export interface GithubRepoMeta {
  owner: string
  name: string
  url: string
  defaultBranch: string
  description: string | null
}

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  py: 'py',
  go: 'go',
  rs: 'rs',
  md: 'md',
  markdown: 'md',
}

export const MAX_FILES = 50

const API = 'https://api.github.com'

function languageOf(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z]+)$/)
  if (!m) return null
  const ext = m[1]
  return SUPPORTED_EXTENSIONS[ext] ?? null
}

async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-repo-qa-bot',
    },
  })
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub API rate limit hit (HTTP ${res.status}). Unauthenticated budget is 60 req/hr.`)
  }
  if (res.status === 404) {
    throw new Error(`GitHub API 404: ${url}`)
  }
  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

/** Fetch the repo metadata (default branch + description). */
export async function fetchRepoMeta(owner: string, name: string): Promise<GithubRepoMeta> {
  const data = await ghJson(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    defaultBranch: data.default_branch ?? 'main',
    description: data.description ?? null,
  }
}

/** Fetch the flat file tree for the default branch (or a given ref). */
export async function fetchRepoTree(owner: string, name: string, ref: string): Promise<GithubFileMeta[]> {
  const data = await ghJson(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  const tree: any[] = data.tree ?? []
  return tree
    .filter((node) => node.type === 'blob')
    .map((node) => ({ path: node.path, size: node.size ?? 0 }))
}

/** Pick the top `MAX_FILES` smallest supported files from a flat tree. */
export function pickSmallestFiles(files: GithubFileMeta[], max = MAX_FILES): GithubFileMeta[] {
  return files
    .filter((f) => languageOf(f.path) !== null)
    .filter((f) => f.size > 0 && f.size < 256 * 1024) // skip empty + files > 256KB
    .sort((a, b) => a.size - b.size)
    .slice(0, max)
}

/** Fetch a single file's content via the contents API. */
export async function fetchFileContent(
  owner: string,
  name: string,
  ref: string,
  path: string,
): Promise<GithubFileContent | null> {
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`
  const data = await ghJson(url)
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    const cleaned = data.content.replace(/\n/g, '')
    const content = Buffer.from(cleaned, 'base64').toString('utf-8')
    return {
      path,
      size: data.size ?? content.length,
      content,
      language: languageOf(path) ?? 'txt',
    }
  }
  return null
}

/**
 * High-level entry: fetch the repo metadata, the flat tree, and the contents
 * of the top `MAX_FILES` smallest supported files. Returns everything the
 * importer needs in a single call.
 */
export async function ingestRepo(owner: string, name: string, refOverride?: string): Promise<{
  meta: GithubRepoMeta
  files: GithubFileContent[]
}> {
  const meta = await fetchRepoMeta(owner, name)
  const ref = refOverride ?? meta.defaultBranch
  const tree = await fetchRepoTree(owner, name, ref)
  const picked = pickSmallestFiles(tree)
  const files: GithubFileContent[] = []
  for (const f of picked) {
    try {
      const content = await fetchFileContent(owner, name, ref, f.path)
      if (content) files.push(content)
    } catch (e) {
      console.warn(`[github-fetch] failed to fetch ${f.path}:`, (e as Error).message)
      // Continue — partial ingest is acceptable within the MVP budget.
    }
  }
  return { meta: { ...meta, defaultBranch: ref }, files }
}
