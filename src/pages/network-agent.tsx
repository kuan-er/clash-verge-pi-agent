import {
  AddCommentOutlined,
  ContentCopy,
  ContentPaste,
  DeleteOutlined,
  ExpandMore,
  Send,
  Stop,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { memo, useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { BasePage } from '@/components/base'
import {
  applySessionChange,
  clearNetworkConversation,
  createNetworkConversation,
  getNetworkSession,
  refreshNetworkStatus,
  sendNetworkMessage,
  selectNetworkConversation,
  setNetworkDraft,
  stopNetworkMessage,
  subscribeNetworkSession,
  undoSessionChange,
  type NetworkMessage,
} from '@/services/network-agent-session'
import { showNotice } from '@/services/notice-service'

const copyNetworkText = async (text: string) => {
  try {
    await writeText(text)
    showNotice.success('shared.feedback.notifications.common.copySuccess', 1000)
  } catch (error) {
    showNotice.error(error)
  }
}

const MessageCard = memo(({ message }: { message: NetworkMessage }) => {
  const { t } = useTranslation()
  return (
    <Card
      variant="outlined"
      sx={{
        p: 2,
        userSelect: 'text',
        WebkitUserSelect: 'text',
        flexShrink: 0,
        ml: message.role === 'user' ? 4 : 0,
        bgcolor: message.role === 'user' ? 'action.hover' : 'background.paper',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {message.role === 'user'
            ? t('networkAgent.you')
            : t('networkAgent.assistant')}
        </Typography>
        {message.status === 'running' && <CircularProgress size={12} />}
        {message.status === 'interrupted' && (
          <Typography variant="caption" color="text.secondary">
            {t('networkAgent.interrupted')}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t('networkAgent.copy')}>
          <IconButton
            size="small"
            aria-label={t('networkAgent.copy')}
            disabled={!message.text}
            onClick={() => void copyNetworkText(message.text)}
          >
            <ContentCopy fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box
        sx={{
          fontSize: 14,
          lineHeight: 1.7,
          overflowWrap: 'anywhere',
          userSelect: 'text',
          WebkitUserSelect: 'text',
          '& > :first-of-type': { mt: 0 },
          '& > :last-child': { mb: 0 },
          '& h1': { fontSize: '1.35em' },
          '& h2': { fontSize: '1.2em' },
          '& h3': { fontSize: '1.1em' },
          '& pre': {
            overflow: 'auto',
            p: 1,
            bgcolor: 'action.hover',
            borderRadius: 1,
          },
          '& table': {
            borderCollapse: 'collapse',
            display: 'block',
            overflowX: 'auto',
          },
          '& td, & th': { border: '1px solid', borderColor: 'divider', p: 0.5 },
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.text}
        </ReactMarkdown>
      </Box>
      {!!message.checks?.length && (
        <Accordion disableGutters elevation={0} sx={{ mt: 1 }}>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography variant="body2">
              {t('networkAgent.evidence')} ({message.checks.length})
              {message.status === 'running'
                ? ` · ${message.checks.at(-1)?.name}`
                : ''}
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 1 }}>
            {message.checks.map((check) => (
              <Box key={check.id} sx={{ mb: 1 }}>
                <Chip
                  size="small"
                  color={
                    check.isError ? 'error' : check.done ? 'success' : 'default'
                  }
                  label={check.name}
                />
                <Box
                  component="pre"
                  sx={{ fontSize: 12, overflow: 'auto', maxHeight: 260 }}
                >
                  {JSON.stringify(
                    { arguments: check.args, result: check.result },
                    null,
                    2,
                  )}
                </Box>
              </Box>
            ))}
          </AccordionDetails>
        </Accordion>
      )}
      {!message.text && message.status === 'running' && (
        <Typography variant="body2" color="text.secondary">
          {t('networkAgent.running')}
        </Typography>
      )}
    </Card>
  )
})

const NetworkAgentPage = () => {
  const { t } = useTranslation()
  const session = useSyncExternalStore(
    subscribeNetworkSession,
    getNetworkSession,
  )
  const {
    messages,
    proposals,
    draft,
    busy,
    changing,
    status,
    error,
    notice,
    model,
    storageError,
    conversations,
    activeConversationId,
    runningConversationId,
    requestBusy,
    loading,
  } = session
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    followRef.current = true
  }, [activeConversationId])
  useEffect(() => {
    void refreshNetworkStatus()
  }, [])
  useEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [messages, proposals, error, notice, activeConversationId])
  const send = (text: string) => {
    followRef.current = true
    void sendNetworkMessage(text)
  }
  const paste = async () => {
    const targetId = activeConversationId
    const input = inputRef.current
    if (!input) return
    const start = input.selectionStart
    const end = input.selectionEnd
    try {
      const text = await readText()
      if (!text || getNetworkSession().activeConversationId !== targetId) return
      const value = getNetworkSession().draft
      setNetworkDraft(value.slice(0, start) + text + value.slice(end))
      requestAnimationFrame(() => {
        input.focus()
        input.setSelectionRange(start + text.length, start + text.length)
      })
    } catch (error) {
      showNotice.error(error)
    }
  }

  return (
    <BasePage
      title={t('networkAgent.title')}
      full
      contentStyle={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      header={
        <Tooltip title={t('networkAgent.clear')}>
          <span>
            <IconButton
              size="small"
              aria-label={t('networkAgent.clear')}
              disabled={busy || changing || loading || !messages.length}
              onClick={clearNetworkConversation}
            >
              <DeleteOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      }
    >
      <Box
        sx={{
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Chip label={`Pi · ${model}`} color="primary" size="small" />
          <Button
            size="small"
            startIcon={<AddCommentOutlined />}
            aria-label={t('networkAgent.newConversation')}
            disabled={changing || loading}
            onClick={createNetworkConversation}
          >
            {t('networkAgent.newConversation')}
          </Button>
          <TextField
            select
            size="small"
            value={activeConversationId}
            label={t('networkAgent.conversations')}
            disabled={changing || loading}
            onChange={(event) => selectNetworkConversation(event.target.value)}
            sx={{ minWidth: 180, flex: 1, maxWidth: 360 }}
          >
            {conversations.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.title || t('networkAgent.untitled')}
                {item.id === runningConversationId
                  ? ` · ${t('networkAgent.inProgress')}`
                  : ''}
              </MenuItem>
            ))}
          </TextField>
          <Chip
            label={t('networkAgent.terminalEnabled')}
            size="small"
            variant="outlined"
          />
          {status && (
            <Chip
              size="small"
              label={`${status.mode} · :${status.mixedPort}`}
            />
          )}
          <Button
            size="small"
            disabled={requestBusy || changing || !status?.undoAvailable}
            onClick={() => void undoSessionChange()}
          >
            {t('networkAgent.undo')}
          </Button>
        </Stack>
      </Box>
      <Box
        ref={scrollRef}
        onScroll={() => {
          const element = scrollRef.current
          if (element)
            followRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              80
        }}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 2,
          py: 2,
          scrollbarGutter: 'stable',
        }}
      >
        <Stack spacing={1.5} sx={{ maxWidth: 1000, mx: 'auto' }}>
          {loading && <CircularProgress size={20} />}
          {requestBusy && !busy && runningConversationId && (
            <Alert
              severity="info"
              action={
                <Button
                  size="small"
                  onClick={() =>
                    selectNetworkConversation(runningConversationId)
                  }
                >
                  {t('networkAgent.returnToRunning')}
                </Button>
              }
            >
              {t('networkAgent.otherConversationRunning')}
            </Alert>
          )}
          {!messages.length && (
            <Box sx={{ py: 3 }}>
              <Typography variant="h6" sx={{ mb: 1 }}>
                {t('networkAgent.welcome')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('networkAgent.description')}
              </Typography>
            </Box>
          )}
          {messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
          {error && <Alert severity="error">{error}</Alert>}
          {storageError && (
            <Alert severity="warning">{t('networkAgent.storageError')}</Alert>
          )}
          {notice && (
            <Alert severity="success">{t(`networkAgent.${notice}`)}</Alert>
          )}
          {proposals.map((change) => (
            <Card key={change.id} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2">
                {t(`networkAgent.fields.${change.field}`)}
              </Typography>
              <Typography component="pre" variant="body2">
                {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {change.reason}
              </Typography>
              <Button
                variant="contained"
                disabled={requestBusy || changing || loading}
                onClick={() => void applySessionChange(change)}
              >
                {t('networkAgent.apply')}
              </Button>
            </Card>
          ))}
        </Stack>
      </Box>
      <Box
        sx={{
          px: 2,
          pt: 1,
          pb: 1.5,
          borderTop: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Stack spacing={1} sx={{ maxWidth: 1000, mx: 'auto' }}>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              disabled={requestBusy || changing || loading}
              onClick={() => send(t('networkAgent.diagnosisPrompt'))}
            >
              {t('networkAgent.diagnose')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={requestBusy || changing || loading}
              onClick={() => send(t('networkAgent.configurationPrompt'))}
            >
              {t('networkAgent.configure')}
            </Button>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
            <TextField
              inputRef={inputRef}
              fullWidth
              multiline
              minRows={2}
              maxRows={5}
              value={draft}
              disabled={changing || loading}
              sx={{
                '& textarea': { userSelect: 'text', WebkitUserSelect: 'text' },
              }}
              placeholder={t('networkAgent.placeholder')}
              onChange={(event) => setNetworkDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  if (!requestBusy && !changing && !loading) send(draft)
                }
              }}
            />
            {busy ? (
              <Button
                variant="outlined"
                startIcon={<Stop />}
                aria-label={t('networkAgent.stop')}
                sx={{ flexShrink: 0, minWidth: 88, whiteSpace: 'nowrap' }}
                onClick={() => void stopNetworkMessage()}
              >
                {t('networkAgent.stop')}
              </Button>
            ) : (
              <Button
                variant="contained"
                disabled={!draft.trim() || requestBusy || changing || loading}
                startIcon={<Send />}
                aria-label={t('networkAgent.send')}
                sx={{ flexShrink: 0, minWidth: 88, whiteSpace: 'nowrap' }}
                onClick={() => send(draft)}
              >
                {t('networkAgent.send')}
              </Button>
            )}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Tooltip title={t('networkAgent.copyInput')}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t('networkAgent.copyInput')}
                  disabled={!draft || loading}
                  onClick={() => {
                    const input = inputRef.current
                    const selected = input
                      ? draft.slice(input.selectionStart, input.selectionEnd)
                      : ''
                    void copyNetworkText(selected || draft)
                  }}
                >
                  <ContentCopy fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('networkAgent.paste')}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t('networkAgent.paste')}
                  disabled={changing || loading}
                  onClick={() => void paste()}
                >
                  <ContentPaste fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography variant="caption" color="text.secondary">
              {t('networkAgent.inputHint')}
            </Typography>
          </Stack>
        </Stack>
      </Box>
    </BasePage>
  )
}

export default NetworkAgentPage
