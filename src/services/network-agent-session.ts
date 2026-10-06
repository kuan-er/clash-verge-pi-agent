import {
  applyNetworkChange,
  cancelNetworkAgent,
  chatWithNetworkAgent,
  networkAgentStatus,
  undoNetworkChange,
  type NetworkAgentEvent,
  type NetworkAgentStatus,
  type NetworkChange,
} from './network-agent'

interface NetworkCheck {
  id: string
  name: string
  args?: unknown
  result?: unknown
  done?: boolean
  isError?: boolean
}

export interface NetworkMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  checks?: NetworkCheck[]
  status?: 'running' | 'done' | 'interrupted'
}

interface Conversation {
  id: string
  title: string
  updatedAt: number
  messages: NetworkMessage[]
  proposals: NetworkChange[]
  draft: string
  model: string
  error: string
  notice: 'applied' | 'undone' | 'stopped' | ''
}

interface SessionState extends Conversation {
  conversations: Pick<Conversation, 'id' | 'title' | 'updatedAt'>[]
  activeConversationId: string
  runningConversationId?: string
  busy: boolean
  requestBusy: boolean
  changing: boolean
  loading: boolean
  storageError: boolean
  status?: NetworkAgentStatus
}

const LEGACY_KEY = 'network-agent-conversation-v1'
const FALLBACK_KEY = 'network-agent-conversations-v2'
const listeners = new Set<() => void>()
const emptyConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  title: '',
  updatedAt: Date.now(),
  messages: [],
  proposals: [],
  draft: '',
  model: 'DeepSeek',
  error: '',
  notice: '',
})
let conversations = [emptyConversation()]
let activeConversationId = conversations[0].id
let activeRequest:
  | { id: string; conversationId: string; stopped: boolean }
  | undefined
let globals: Pick<
  SessionState,
  'changing' | 'loading' | 'storageError' | 'status'
> = {
  changing: false,
  loading: true,
  storageError: false,
}
let database: IDBDatabase | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let migratedLegacy = false
let migratedFallback = false

function currentConversation() {
  return conversations.find((item) => item.id === activeConversationId)!
}

function snapshot(): SessionState {
  return {
    ...currentConversation(),
    ...globals,
    activeConversationId,
    conversations: conversations.map(({ id, title, updatedAt }) => ({
      id,
      title,
      updatedAt,
    })),
    runningConversationId: activeRequest?.conversationId,
    busy: activeRequest?.conversationId === activeConversationId,
    requestBusy: Boolean(activeRequest),
  }
}
let state = snapshot()

function notify(persist = true) {
  state = snapshot()
  listeners.forEach((listener) => listener())
  if (persist && !globals.loading) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), 300)
  }
}

function updateConversation(id: string, patch: Partial<Conversation>) {
  conversations = conversations.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
  )
  notify()
}

function updateGlobals(patch: Partial<typeof globals>) {
  globals = { ...globals, ...patch }
  notify(false)
}

function networkAgentError(error: unknown) {
  if (typeof error === 'object' && error !== null && 'detail' in error)
    return String(error.detail)
  return error instanceof Error ? error.message : String(error)
}

async function hydrate() {
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pash-network-agent', 1)
      request.onupgradeneeded = () =>
        request.result.createObjectStore('workspace')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } catch {
    globals.storageError = true
  }
  try {
    let saved = database
      ? await new Promise<any>((resolve, reject) => {
          const request = database!
            .transaction('workspace')
            .objectStore('workspace')
            .get('conversations')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      : JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null')
    if (!saved && database) {
      saved = JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null')
      migratedFallback = Boolean(saved)
    }
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null')
      if (legacy?.version === 1 && Array.isArray(legacy.messages)) {
        const first = legacy.messages.find(
          (item: NetworkMessage) => item.role === 'user' && item.text.trim(),
        )
        const conversation = {
          ...emptyConversation(),
          ...legacy,
          title: first?.text.trim().replace(/\s+/g, ' ').slice(0, 40) || '',
        }
        saved = {
          version: 2,
          conversations: [conversation],
          activeConversationId: conversation.id,
        }
        migratedLegacy = true
      }
    }
    if (
      saved?.version === 2 &&
      Array.isArray(saved.conversations) &&
      saved.conversations.length
    ) {
      conversations = saved.conversations.map((item: Conversation) => ({
        ...emptyConversation(),
        ...item,
        error: '',
        notice: '',
        messages: item.messages.map((message) => ({
          ...message,
          status: message.status === 'running' ? 'interrupted' : message.status,
          checks: message.checks?.map((check) => ({
            ...check,
            isError: check.done ? check.isError : true,
            done: true,
          })),
        })),
      }))
      activeConversationId = conversations.some(
        (item) => item.id === saved.activeConversationId,
      )
        ? saved.activeConversationId
        : conversations[0].id
    }
  } catch {
    globals.storageError = true
  }
  updateGlobals({ loading: false })
  if (migratedLegacy || migratedFallback) void save()
}
const ready = hydrate()

async function save() {
  clearTimeout(saveTimer)
  await ready
  const saved = {
    version: 2,
    activeConversationId,
    conversations: conversations.map((conversation) => ({
      ...conversation,
      error: '',
      notice: '',
      messages: conversation.messages.slice(-80).map((message) => ({
        ...message,
        checks: message.checks?.map((check) => {
          const result = JSON.stringify(check.result)
          return result?.length > 8192
            ? { ...check, result: result.slice(0, 8192) + '\n[truncated]' }
            : check
        }),
      })),
    })),
  }
  try {
    if (database) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database!.transaction('workspace', 'readwrite')
        transaction.objectStore('workspace').put(saved, 'conversations')
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } else localStorage.setItem(FALLBACK_KEY, JSON.stringify(saved))
    if (migratedLegacy) {
      localStorage.removeItem(LEGACY_KEY)
      migratedLegacy = false
    }
    if (migratedFallback) {
      localStorage.removeItem(FALLBACK_KEY)
      migratedFallback = false
    }
  } catch {
    updateGlobals({ storageError: true })
  }
}

window.addEventListener('pagehide', () => {
  void save()
  if (activeRequest) void cancelNetworkAgent(activeRequest.id)
})

export const getNetworkSession = () => state
export const subscribeNetworkSession = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const setNetworkDraft = (draft: string) =>
  updateConversation(activeConversationId, { draft })

export function createNetworkConversation() {
  if (globals.loading || globals.changing) return
  const conversation = emptyConversation()
  conversations = [conversation, ...conversations]
  activeConversationId = conversation.id
  notify()
}

export function selectNetworkConversation(id: string) {
  if (
    globals.loading ||
    globals.changing ||
    !conversations.some((item) => item.id === id)
  )
    return
  activeConversationId = id
  notify()
}

export async function refreshNetworkStatus() {
  try {
    updateGlobals({ status: await networkAgentStatus() })
  } catch (error) {
    updateConversation(activeConversationId, {
      error: networkAgentError(error),
    })
  }
}

export async function sendNetworkMessage(text: string) {
  await ready
  if (activeRequest || globals.changing || !text.trim()) return
  const conversation = currentConversation()
  const request = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    stopped: false,
  }
  const assistantId = crypto.randomUUID()
  const history = conversation.messages
    .filter((message) => message.text.trim())
    .slice(-24)
    .map(({ role, text }) => ({ role, text: text.slice(-8000) }))
  activeRequest = request
  updateConversation(conversation.id, {
    title: conversation.title || text.trim().replace(/\s+/g, ' ').slice(0, 40),
    draft: '',
    error: '',
    notice: '',
    proposals: [],
    messages: [
      ...conversation.messages,
      { id: crypto.randomUUID(), role: 'user', text },
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        checks: [],
        status: 'running',
      },
    ],
  })
  const message = () =>
    conversations
      .find((item) => item.id === conversation.id)!
      .messages.find((item) => item.id === assistantId)!
  const updateMessage = (patch: Partial<NetworkMessage>) => {
    const target = conversations.find((item) => item.id === conversation.id)!
    updateConversation(conversation.id, {
      messages: target.messages.map((item) =>
        item.id === assistantId ? { ...item, ...patch } : item,
      ),
    })
  }
  let streamId: string | undefined
  let prefix = ''
  let pendingText = ''
  let textTimer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(textTimer)
    textTimer = undefined
    updateMessage({ text: pendingText })
  }
  const receive = (event: NetworkAgentEvent) => {
    if (activeRequest !== request) return
    if (event.type === 'text') {
      if (streamId && streamId !== event.id) prefix = pendingText
      streamId = event.id
      pendingText = [prefix, event.text].filter(Boolean).join('\n\n')
      textTimer ??= setTimeout(flush, 80)
    } else {
      const checks = message().checks || []
      updateMessage({
        checks:
          event.type === 'tool_start'
            ? [
                ...checks,
                { id: event.id!, name: event.name!, args: event.args },
              ]
            : checks.map((check) =>
                check.id === event.id
                  ? {
                      ...check,
                      result: event.result,
                      done: event.type === 'tool_end',
                      isError: event.isError,
                    }
                  : check,
              ),
      })
    }
  }
  try {
    const result = await chatWithNetworkAgent(
      request.id,
      text,
      history,
      receive,
    )
    clearTimeout(textTimer)
    updateMessage({
      text: [prefix, result.text].filter(Boolean).join('\n\n'),
      status: 'done',
    })
    updateConversation(conversation.id, {
      proposals: result.proposals,
      model: result.model,
    })
  } catch (error) {
    flush()
    updateMessage({
      status: 'interrupted',
      checks: message().checks?.map((check) =>
        check.done ? check : { ...check, done: true, isError: true },
      ),
    })
    const detail = networkAgentError(error)
    updateConversation(
      conversation.id,
      request.stopped && /cancel|abort/i.test(detail)
        ? { error: '', notice: 'stopped' }
        : { error: detail },
    )
  } finally {
    activeRequest = undefined
    notify()
    void save()
  }
}

export async function stopNetworkMessage() {
  if (!activeRequest) return
  const request = activeRequest
  request.stopped = true
  try {
    await cancelNetworkAgent(request.id)
  } catch (error) {
    updateConversation(request.conversationId, {
      error: networkAgentError(error),
    })
  }
}

export async function applySessionChange(change: NetworkChange) {
  if (activeRequest || globals.changing) return
  const id = activeConversationId
  updateGlobals({ changing: true })
  updateConversation(id, { error: '' })
  try {
    await applyNetworkChange(change)
    const conversation = conversations.find((item) => item.id === id)!
    updateConversation(id, {
      proposals: conversation.proposals.filter((item) => item.id !== change.id),
      notice: 'applied',
      messages: [
        ...conversation.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: `[Clash setting applied] ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`,
        },
      ],
    })
  } catch (error) {
    updateConversation(id, { error: networkAgentError(error) })
  } finally {
    await refreshNetworkStatus()
    updateGlobals({ changing: false })
  }
}

export async function undoSessionChange() {
  if (activeRequest || globals.changing) return
  const id = activeConversationId
  updateGlobals({ changing: true })
  updateConversation(id, { error: '' })
  try {
    await undoNetworkChange()
    const conversation = conversations.find((item) => item.id === id)!
    updateConversation(id, {
      notice: 'undone',
      proposals: [],
      messages: [
        ...conversation.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: '[Latest Clash setting undone]',
        },
      ],
    })
  } catch (error) {
    updateConversation(id, { error: networkAgentError(error) })
  } finally {
    await refreshNetworkStatus()
    updateGlobals({ changing: false })
  }
}

export function clearNetworkConversation() {
  if (
    activeRequest?.conversationId === activeConversationId ||
    globals.changing ||
    globals.loading
  )
    return
  updateConversation(activeConversationId, {
    title: '',
    messages: [],
    proposals: [],
    draft: '',
    error: '',
    notice: '',
  })
  void save()
}
