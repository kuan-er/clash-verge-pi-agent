import { AccountCircleOutlined, CheckCircleOutlined, OpenInNew } from '@mui/icons-material'
import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material'
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'

import { BasePage } from '@/components/base'
import { revalidateProfiles } from '@/hooks/use-profiles'
import { openExternalUrl } from '@/utils/open-external-url'

interface AccountInfo {
  user: {
    username: string
    role: string
    total: number
    upload: number
    download: number
    onlineIPs: string[]
  }
  configured: boolean
}

const size = (value: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index > 1 ? 2 : 0)} ${units[index]}`
}

const detail = (error: unknown) =>
  typeof error === 'object' && error && 'detail' in error
    ? String(error.detail)
    : String(error)

export default function AccountPage() {
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setAccount(await invoke<AccountInfo | null>('portal_account'))
    } catch (error) {
      setError(detail(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <BasePage title="pash 账户">
      <Box sx={{ maxWidth: 760, mx: 'auto', px: 3, py: 4 }}>
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Typography variant="h5" sx={{ fontWeight: 650 }}>
            你的美国直连网络
          </Typography>
          <Typography color="text.secondary" sx={{ fontSize: 14 }}>
            使用用户中心的账户登录，自动获取并启用你的个人代理配置。
          </Typography>
        </Stack>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {configured && <Alert severity="success" sx={{ mb: 2 }}>美国直连配置已启用，系统代理已开启。</Alert>}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={28} /></Box>
        ) : account ? (
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <AccountCircleOutlined sx={{ fontSize: 38, color: 'primary.main' }} />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 600 }}>{account.user.username}</Typography>
                <Typography color="text.secondary" sx={{ fontSize: 12 }}>{account.user.role === 'admin' ? '管理员账户' : '个人账户'}</Typography>
              </Box>
              <CheckCircleOutlined color="success" />
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, my: 4 }}>
              {[['累计用量', account.user.total], ['下载', account.user.download], ['上传', account.user.upload]].map(([label, value]) => (
                <Box key={label}>
                  <Typography color="text.secondary" sx={{ fontSize: 12 }}>{label}</Typography>
                  <Typography sx={{ fontSize: 23, fontWeight: 600, mt: 0.7 }}>{size(Number(value))}</Typography>
                </Box>
              ))}
            </Box>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button variant="contained" startIcon={<OpenInNew />} onClick={() => void openExternalUrl('https://154.40.137.121:8443')}>打开用户中心</Button>
              <Button disabled={busy} onClick={async () => {
                setBusy(true)
                try { await invoke('portal_logout'); setAccount(null); setConfigured(false) }
                catch (error) { setError(detail(error)) }
                finally { setBusy(false) }
              }}>退出账户，保留网络配置</Button>
            </Stack>
          </Paper>
        ) : (
          <Paper component="form" variant="outlined" sx={{ p: 3, borderRadius: 3 }} onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true); setError('')
            try {
              const result = await invoke<AccountInfo>('portal_login', { username: username.trim(), password })
              setAccount(result); setPassword(''); setConfigured(true)
              await revalidateProfiles()
            } catch (error) { setError(detail(error)) }
            finally { setBusy(false) }
          }}>
            <Stack spacing={2.5}>
              <Typography sx={{ fontWeight: 600 }}>登录并配置 pash</Typography>
              <TextField label="用户名" value={username} autoComplete="username" required onChange={(event) => setUsername(event.target.value)} disabled={busy} />
              <TextField label="密码" type="password" value={password} autoComplete="current-password" required onChange={(event) => setPassword(event.target.value)} disabled={busy} />
              <Button type="submit" variant="contained" size="large" disabled={busy} sx={{ minHeight: 46 }}>
                {busy ? <><CircularProgress color="inherit" size={18} sx={{ mr: 1 }} />正在登录并应用配置…</> : '登录并启用美国直连'}
              </Button>
              <Button startIcon={<OpenInNew />} onClick={() => void openExternalUrl('https://154.40.137.121:8443')}>打开用户中心</Button>
            </Stack>
          </Paper>
        )}
      </Box>
    </BasePage>
  )
}
