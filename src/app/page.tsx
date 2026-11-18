'use client'

import * as React from 'react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Github,
  FileText,
  Send,
  Loader2,
  Search,
  Sparkles,
  Filter,
  Trash2,
  ExternalLink,
  CornerDownLeft,
  X,
  Code,
} from 'lucide-react'

// ---------- types ----------
interface Repo {
  id: string
  owner: string
  name: string
  url: string
  defaultBranch: string | null
  description: string | null
  importedAt: string
  updatedAt: string
  _count: { files: number; chunks: number }
}
interface RepoFile {
  id: string
  path: string
  language: string
  lineCount: number
  _count: { chunks: number }
}
interface Citation {
  chunkId: string
  repoId: string
  fileId: string
  filePath: string
  symbolName: string | null
  startLine: number
  endLine: number
  preview: string
  githubUrl: string
}
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  pending?: boolean
}
interface WhereUsedResult {
  fileId: string
  filePath: string
  lineMatches: number[]
  preview: string
}

// ---------- inline citation rendering ----------
function renderCitationsInline(content: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /\[\^(c\d+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      parts.push(<React.Fragment key={`t-${last}`}>{content.slice(last, m.index)}</React.Fragment>)
    }
    const id = m[1]
    parts.push(
      <a
        key={`c-${m.index}`}
        href={`#cite-${id}`}
        className="text-primary text-xs align-super mx-0.5 px-1 rounded bg-primary/10 hover:bg-primary/20 no-underline"
      >
        [{id}]
      </a>,
    )
    last = m.index + m[0].length
  }
  if (last < content.length) {
    parts.push(<React.Fragment key={`t-${last}`}>{content.slice(last)}</React.Fragment>)
  }
  return parts
}

// ---------- main page ----------
export default function Page() {
  const { toast } = useToast()

  // --- data state ---
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [selectedRepoId, setSelectedRepoId] = React.useState<string | null>(null)
  const [files, setFiles] = React.useState<RepoFile[]>([])
  const [filterFileIds, setFilterFileIds] = React.useState<Set<string>>(new Set())

  // --- import state ---
  const [importUrl, setImportUrl] = React.useState('')
  const [importing, setImporting] = React.useState(false)

  // --- chat state ---
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = React.useState('')
  const [streaming, setStreaming] = React.useState(false)
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const chatScrollRef = React.useRef<HTMLDivElement>(null)

  // --- "Where used?" state ---
  const [whereUsedMode, setWhereUsedMode] = React.useState(false)
  const [wuSymbol, setWuSymbol] = React.useState('')
  const [wuResults, setWuResults] = React.useState<WhereUsedResult[]>([])
  const [wuLoading, setWuLoading] = React.useState(false)

  // ---------- initial load ----------
  React.useEffect(() => {
    refreshRepos().then(() => {})
  }, [])

  async function refreshRepos() {
    try {
      const res = await fetch('/api/repos')
      if (!res.ok) return
      const data = await res.json()
      setRepos(data.repos ?? [])
    } catch (e) {
      // silently ignore — UI still renders with empty state
    }
  }

  // ---------- when selectedRepoId changes, fetch files ----------
  React.useEffect(() => {
    if (!selectedRepoId) {
      setFiles([])
      setFilterFileIds(new Set())
      return
    }
    let cancelled = false
    fetch(`/api/repos/${selectedRepoId}/files`)
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((d) => {
        if (cancelled) return
        setFiles(d.files ?? [])
        setFilterFileIds(new Set())
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selectedRepoId])

  // ---------- import handler ----------
  async function handleImport() {
    const url = importUrl.trim()
    if (!url) return
    setImporting(true)
    try {
      const res = await fetch('/api/repos/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({
          title: 'Import failed',
          description: data?.error ?? `HTTP ${res.status}`,
          variant: 'destructive',
        })
        return
      }
      toast({
        title: 'Repo imported',
        description: `${data.fileCount} files, ${data.chunkCount} chunks`,
      })
      setImportUrl('')
      await refreshRepos()
      setSelectedRepoId(data.repoId)
    } catch (e) {
      toast({
        title: 'Import failed',
        description: (e as Error).message,
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  // ---------- delete handler ----------
  async function handleDeleteRepo(id: string) {
    if (!confirm('Delete this repo and all its files / chunks?')) return
    try {
      await fetch(`/api/repos/${id}`, { method: 'DELETE' })
      if (selectedRepoId === id) setSelectedRepoId(null)
      await refreshRepos()
    } catch (e) {
      toast({ title: 'Delete failed', description: (e as Error).message, variant: 'destructive' })
    }
  }

  // ---------- file filter toggle ----------
  function toggleFilterFile(id: string) {
    setFilterFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearFilters() {
    setFilterFileIds(new Set())
  }

  // ---------- chat send (streaming) ----------
  async function handleSend() {
    const msg = chatInput.trim()
    if (!msg || streaming) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: msg,
      citations: [],
    }
    const placeholder: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      citations: [],
      pending: true,
    }
    setMessages((prev) => [...prev, userMsg, placeholder])
    setChatInput('')
    setStreaming(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          sessionId: sessionId ?? undefined,
          filterFileIds: filterFileIds.size > 0 ? Array.from(filterFileIds) : undefined,
          repoId: selectedRepoId ?? undefined,
        }),
      })
      if (!res.ok || !res.body) {
        toast({ title: 'Chat failed', description: `HTTP ${res.status}`, variant: 'destructive' })
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholder.id ? { ...m, pending: false, content: `[error] HTTP ${res.status}` } : m,
          ),
        )
        setStreaming(false)
        return
      }
      if (res.headers.get('X-Session-Id')) {
        setSessionId(res.headers.get('X-Session-Id'))
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullMessage = ''
      let citations: Citation[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Detect the citations footer
        const sepIdx = buffer.indexOf('\n---CITATIONS---\n')
        let chunk = buffer
        if (sepIdx >= 0) {
          chunk = buffer.slice(0, sepIdx)
          const footer = buffer.slice(sepIdx + '\n---CITATIONS---\n'.length)
          try {
            const parsed = JSON.parse(footer)
            citations = parsed?.citations ?? []
          } catch {
            // ignore
          }
          buffer = ''
        } else {
          buffer = ''
        }
        if (chunk) {
          fullMessage += chunk
          setMessages((prev) =>
            prev.map((m) => (m.id === placeholder.id ? { ...m, content: fullMessage } : m)),
          )
        }
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholder.id ? { ...m, pending: false, content: fullMessage, citations } : m,
        ),
      )
    } catch (e) {
      toast({ title: 'Chat failed', description: (e as Error).message, variant: 'destructive' })
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholder.id
            ? { ...m, pending: false, content: `[error] ${(e as Error).message}` }
            : m,
        ),
      )
    } finally {
      setStreaming(false)
    }
  }

  // ---------- autoscroll on new messages ----------
  React.useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [messages])

  // ---------- where-used handler ----------
  async function handleWhereUsed() {
    const sym = wuSymbol.trim()
    if (!sym || !selectedRepoId) return
    setWuLoading(true)
    try {
      const res = await fetch('/api/where-used', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: selectedRepoId, symbolName: sym }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: 'Lookup failed', description: data?.error ?? `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setWuResults(data.results ?? [])
    } catch (e) {
      toast({ title: 'Lookup failed', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setWuLoading(false)
    }
  }

  // ---------- render ----------
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="px-4 md:px-6 py-3 flex items-center gap-3">
          <Github className="size-6 shrink-0" />
          <div className="flex-1 min-w-0">
            <h1 className="text-base md:text-lg font-semibold truncate">GitHub Repo Q&A Bot</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">
              Drop a GitHub URL → ingest top 50 files → AST-chunk TS/JS → hybrid retrieval → grounded chat.
            </p>
          </div>
          <StatsBadge />
          <Button
            variant={whereUsedMode ? 'default' : 'outline'}
            size="sm"
            onClick={() => setWhereUsedMode((v) => !v)}
          >
            <Search className="size-4" />
            Where used?
          </Button>
        </div>
      </header>

      {/* 3-column layout (collapses on mobile) */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-[280px_1fr] lg:grid-cols-[280px_1fr_320px] gap-0">
        {/* Left: repo list + add + file tree */}
        <aside className="border-r bg-card/30 flex flex-col min-h-0">
          <div className="p-4 space-y-3 border-b">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Github className="size-4" /> Add repo by URL
            </h2>
            <div className="flex gap-2">
              <Input
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                onKeyDown={(e) => e.key === 'Enter' && !importing && handleImport()}
                disabled={importing}
              />
              <Button size="icon" onClick={handleImport} disabled={importing || !importUrl.trim()}>
                {importing ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Unauthenticated contents API — 60 req/hr. Imports the 50 smallest supported files.
            </p>
          </div>

          <div className="p-4 border-b">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Repos ({repos.length})
            </h3>
            {repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">No repos yet. Paste a URL above.</p>
            ) : (
              <ul className="space-y-1 max-h-48 overflow-y-auto thin-scroll">
                {repos.map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelectedRepoId(r.id)}
                      className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-start gap-2 hover:bg-accent transition-colors ${
                        selectedRepoId === r.id ? 'bg-accent' : ''
                      }`}
                    >
                      <Github className="size-3.5 mt-0.5 shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium truncate">
                          {r.owner}/{r.name}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {r._count.files} files · {r._count.chunks} chunks
                        </span>
                      </span>
                      <Trash2
                        className="size-3.5 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteRepo(r.id)
                        }}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="p-4 flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
                <Filter className="size-3" /> File filter
              </h3>
              {filterFileIds.size > 0 && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-6 text-[11px]">
                  Clear ({filterFileIds.size})
                </Button>
              )}
            </div>
            {!selectedRepoId ? (
              <p className="text-xs text-muted-foreground">Select a repo to see its files.</p>
            ) : files.length === 0 ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <ScrollArea className="flex-1 min-h-0 thin-scroll">
                <ul className="space-y-1 pr-2">
                  {files.map((f) => (
                    <li key={f.id}>
                      <label className="flex items-start gap-2 px-2 py-1 rounded hover:bg-accent cursor-pointer text-xs">
                        <Checkbox
                          checked={filterFileIds.has(f.id)}
                          onCheckedChange={() => toggleFilterFile(f.id)}
                          className="mt-0.5"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block font-mono truncate">{f.path}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {f.language} · {f.lineCount} lines · {f._count.chunks} chunks
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>
        </aside>

        {/* Center: chat */}
        <main className="flex flex-col min-h-0 bg-background">
          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto thin-scroll p-4 md:p-6 space-y-4"
          >
            {messages.length === 0 ? (
              <EmptyChatState selectedRepoId={selectedRepoId} />
            ) : (
              messages.map((m) => <ChatBubble key={m.id} message={m} />)
            )}
          </div>
          <div className="border-t p-3 md:p-4 bg-card/30">
            <div className="flex gap-2 items-end">
              <Input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={
                  selectedRepoId
                    ? 'Ask about the repo…'
                    : 'Import a repo to start asking…'
                }
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                disabled={streaming}
                className="flex-1"
              />
              <Button onClick={handleSend} disabled={streaming || !chatInput.trim()}>
                {streaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Citations use [^c1] markers. Each citation has an &quot;Open on GitHub&quot; link to the source lines.
            </p>
          </div>
        </main>

        {/* Right: where-used (when toggle is on) */}
        {whereUsedMode && (
          <aside className="border-l bg-card/30 flex flex-col min-h-0">
            <div className="p-4 border-b">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Search className="size-4" /> Where is X used?
              </h2>
              <div className="flex gap-2">
                <Input
                  value={wuSymbol}
                  onChange={(e) => setWuSymbol(e.target.value)}
                  placeholder="SymbolName"
                  onKeyDown={(e) => e.key === 'Enter' && handleWhereUsed()}
                  disabled={wuLoading || !selectedRepoId}
                />
                <Button
                  size="icon"
                  onClick={handleWhereUsed}
                  disabled={wuLoading || !wuSymbol.trim() || !selectedRepoId}
                >
                  {wuLoading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Whole-word regex match (case-sensitive). Matches inside comments are skipped.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto thin-scroll p-4">
              {!selectedRepoId ? (
                <p className="text-xs text-muted-foreground">Select a repo first.</p>
              ) : wuResults.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {wuSymbol ? 'No matches yet — search above.' : 'Enter a symbol name above.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {wuResults.map((r) => (
                    <li key={r.fileId} className="text-xs border rounded-md p-2">
                      <div className="font-mono font-medium truncate flex items-center gap-1">
                        <FileText className="size-3 shrink-0" />
                        {r.filePath}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {r.lineMatches.length} match{r.lineMatches.length === 1 ? '' : 'es'}: L{r.lineMatches.slice(0, 6).join(', L')}
                        {r.lineMatches.length > 6 ? ` +${r.lineMatches.length - 6}` : ''}
                      </div>
                      <pre className="mt-1 text-[10px] bg-muted/40 rounded p-1 overflow-x-auto whitespace-pre-wrap">
                        {r.preview}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t bg-card/30 px-4 md:px-6 py-2 text-[11px] text-muted-foreground text-center">
        GitHub Repo Q&A Bot · MVP · single-repo ingest · top 50 small files · AST + regex chunking · hybrid RAG
      </footer>
    </div>
  )
}

// ---------- sub-components ----------
function StatsBadge() {
  const [stats, setStats] = React.useState<{ repos: number; files: number; chunks: number } | null>(null)
  React.useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {})
  }, [])
  if (!stats) return null
  return (
    <Badge variant="secondary" className="hidden sm:inline-flex">
      {stats.repos} repos · {stats.files} files · {stats.chunks} chunks
    </Badge>
  )
}

function EmptyChatState({ selectedRepoId }: { selectedRepoId: string | null }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-3 py-12">
      <Sparkles className="size-10 opacity-30" />
      <div>
        <p className="text-sm font-medium">
          {selectedRepoId ? 'Ask anything about the repo.' : 'Import a repo to start asking questions.'}
        </p>
        <p className="text-xs mt-1">
          Answers are grounded in retrieved code chunks with [^c1] citations and file:line references.
        </p>
      </div>
    </div>
  )
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[88%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-card border'
        }`}
      >
        {isUser ? message.content : renderCitationsInline(message.content || (message.pending ? '…' : ''))}
        {message.pending && !message.content && (
          <Loader2 className="size-3 animate-spin inline-block ml-2" />
        )}
      </div>
      {!isUser && message.citations.length > 0 && (
        <div className="max-w-[88%] w-full space-y-1.5">
          <div className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
            <Code className="size-3" /> Citations
          </div>
          {message.citations.map((c) => (
            <CitationCard key={c.chunkId} citation={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function CitationCard({ citation }: { citation: Citation }) {
  const symbolTag = citation.symbolName ? `:${citation.symbolName}` : ''
  const lineTag = ` (L${citation.startLine}-${citation.endLine})`
  return (
    <div className="border rounded-md p-2 bg-card/50 text-xs">
      <div className="flex items-start gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {citation.filePath}
          {symbolTag}
          {lineTag}
        </Badge>
        <a
          href={citation.githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[10px] text-primary hover:underline inline-flex items-center gap-1"
        >
          Open on GitHub <ExternalLink className="size-3" />
        </a>
      </div>
      <pre className="mt-1.5 text-[10px] text-muted-foreground bg-muted/30 rounded p-1.5 overflow-x-auto whitespace-pre-wrap max-h-32">
        {citation.preview}
      </pre>
    </div>
  )
}
