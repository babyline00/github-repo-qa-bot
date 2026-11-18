import { test, expect, describe } from 'bun:test'
import { parseGithubUrl, githubBlobLink } from '../url-parser'

describe('parseGithubUrl — happy path', () => {
  test('canonical https URL', () => {
    expect(parseGithubUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('https URL with .git suffix', () => {
    expect(parseGithubUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('https URL with /tree/branch', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      name: 'repo',
      branch: 'main',
    })
  })
  test('https URL with /tree/feature/branch (slashes in branch name)', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/tree/feature/foo')).toEqual({
      owner: 'owner',
      name: 'repo',
      branch: 'feature/foo',
    })
  })
  test('http (insecure) URL is accepted', () => {
    expect(parseGithubUrl('http://github.com/owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('URL without protocol gets https:// prepended', () => {
    expect(parseGithubUrl('github.com/owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('SSH form: git@github.com:owner/repo.git', () => {
    expect(parseGithubUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('SSH form without .git suffix', () => {
    expect(parseGithubUrl('git@github.com:owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('URL with trailing slash', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
  test('URL with www. prefix', () => {
    expect(parseGithubUrl('https://www.github.com/owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
    })
  })
})

describe('parseGithubUrl — rejections', () => {
  test('empty string', () => {
    expect(parseGithubUrl('')).toBeNull()
  })
  test('non-GitHub host: gitlab.com', () => {
    expect(parseGithubUrl('https://gitlab.com/owner/repo')).toBeNull()
  })
  test('non-GitHub host: bitbucket.org', () => {
    expect(parseGithubUrl('https://bitbucket.org/owner/repo')).toBeNull()
  })
  test('github.com root (no owner/name)', () => {
    expect(parseGithubUrl('https://github.com/')).toBeNull()
  })
  test('github.com with only owner', () => {
    expect(parseGithubUrl('https://github.com/owner')).toBeNull()
  })
  test('SSH form with only one segment', () => {
    expect(parseGithubUrl('git@github.com:owner')).toBeNull()
  })
  test('invalid characters in name', () => {
    expect(parseGithubUrl('https://github.com/owner/re po')).toBeNull()
  })
})

describe('githubBlobLink', () => {
  test('builds canonical /blob/<ref>/<path>#Lstart-Lend link', () => {
    const link = githubBlobLink('owner', 'repo', 'main', 'src/lib/ai.ts', 12, 18)
    expect(link).toBe('https://github.com/owner/repo/blob/main/src/lib/ai.ts#L12-L18')
  })
  test('single-line anchor when start === end', () => {
    const link = githubBlobLink('owner', 'repo', 'main', 'README.md', 5, 5)
    expect(link).toBe('https://github.com/owner/repo/blob/main/README.md#L5')
  })
  test('encodes path with slashes and special chars', () => {
    const link = githubBlobLink('owner', 'repo', 'main', 'src/file with space.ts', 1, 1)
    expect(link).toContain('/blob/main/src/file%20with%20space.ts#L1')
  })
  test('encodes ref with slash (e.g. a tag like v1.0/feature)', () => {
    const link = githubBlobLink('owner', 'repo', 'v1.0/feature', 'a.ts', 1, 2)
    expect(link).toContain('/blob/v1.0%2Ffeature/a.ts#L1-L2')
  })
})
