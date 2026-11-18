/**
 * GitHub URL parser — accepts the four common GitHub repo URL formats and
 * extracts `{ owner, name, branch? }`. Returns `null` for non-GitHub URLs
 * or URLs that don't resolve to a repo root.
 *
 * Accepted:
 *  - https://github.com/owner/repo
 *  - https://github.com/owner/repo/tree/branch
 *  - https://github.com/owner/repo.git
 *  - git@github.com:owner/repo.git
 *  - http://github.com/owner/repo (insecure but accepted)
 *
 * Rejected:
 *  - gitlab.com / bitbucket.org / any non-github host
 *  - URLs missing owner or repo segments
 */

export interface ParsedRepoUrl {
  owner: string
  name: string
  /** Optional branch extracted from `/tree/<branch>` segments. */
  branch?: string
}

const SSH_RE = /^git@github\.com:(.+?)(?:\.git)?$/i

export function parseGithubUrl(raw: string): ParsedRepoUrl | null {
  if (!raw || typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url) return null

  // --- SSH form: git@github.com:owner/repo(.git) ---
  const ssh = url.match(SSH_RE)
  if (ssh) {
    const path = ssh[1]
    const parts = path.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]
    const name = stripGitSuffix(parts[1])
    if (!isValidSegment(owner) || !isValidSegment(name)) return null
    return { owner, name }
  }

  // --- HTTPS / HTTP form ---
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`
  let parsed: URL
  try {
    parsed = new URL(withProto)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return null

  const owner = segments[0]
  const name = stripGitSuffix(segments[1])
  if (!isValidSegment(owner) || !isValidSegment(name)) return null

  let branch: string | undefined
  if (segments.length >= 4 && segments[2].toLowerCase() === 'tree') {
    branch = segments.slice(3).join('/')
  }

  return { owner, name, branch }
}

function stripGitSuffix(seg: string): string {
  return seg.endsWith('.git') ? seg.slice(0, -4) : seg
}

function isValidSegment(seg: string): boolean {
  if (!seg) return false
  return /^[a-zA-Z0-9._-]+$/.test(seg)
}

/**
 * Build the canonical "Open on GitHub" link for a code citation. Format:
 *   https://github.com/owner/repo/blob/sha/path#L-startLine-L-endLine
 *
 * GitHub accepts a branch name in /blob/<ref>/ when the commit SHA isn't
 * tracked (MVP stores the default branch, not the per-file SHA).
 */
export function githubBlobLink(
  owner: string,
  name: string,
  ref: string,
  path: string,
  startLine: number,
  endLine: number,
): string {
  const refSegment = encodeURIComponent(ref)
  const pathSegment = path.split('/').map(encodeURIComponent).join('/')
  const anchor = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`
  return `https://github.com/${owner}/${name}/blob/${refSegment}/${pathSegment}#${anchor}`
}
