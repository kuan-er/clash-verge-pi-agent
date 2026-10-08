const root = document.querySelector('#app')
let account = null
let overview = null
let page = 'dashboard'
let updating = false
const icons = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  downloads:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  security:
    '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
}
const brand =
  '<div class="brand"><span class="logo">P</span><span>ash</span></div>'
const svg = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  )
function bytes(value) {
  const v = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0,
    n = v
  while (n >= 1024 && index < units.length - 1) {
    n /= 1024
    index++
  }
  return `${n.toFixed(index > 1 ? 2 : 0)} ${units[index]}`
}
const rate = (value) => bytes(value) + '/s'
const date = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
    : '—'
function toast(text) {
  const element = document.querySelector('#toast')
  element.textContent = text
  element.classList.add('show')
  setTimeout(() => element.classList.remove('show'), 3200)
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) {
    if (response.status === 401 && account) {
      account = null
      renderLogin()
    }
    throw new Error(data.error || '请求失败')
  }
  return data
}
function renderLogin() {
  root.innerHTML = `<main class="login"><section class="intro">${brand}<div class="orbit"></div><div class="intro-copy"><div class="eyebrow">YOUR NETWORK, SIMPLIFIED</div><h1>连接世界，<br>从这里开始。</h1><p>为你准备好的美国直连网络。<br>下载 pash，登录账户，让连接与配置变得简单。</p></div><footer>pash 用户中心 · 美国直连</footer></section><section class="login-area"><div class="login-form"><div class="mobile-brand">${brand}</div><div class="eyebrow">WELCOME BACK</div><h2>登录你的账户</h2><p class="subtle">管理连接、查看用量，获取专属配置。</p><form id="login-form"><label class="field">用户名<input name="username" autocomplete="username" required maxlength="40" placeholder="输入用户名"></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" required maxlength="256" placeholder="输入密码"></label><div class="error" id="login-error" role="alert"></div><button class="button wide" type="submit">登录用户中心 <span aria-hidden="true">↗</span></button></form><p class="login-foot">账户由管理员开通 · 专属配置与用量统计</p></div></section></main>`
  document.querySelector('#login-form').onsubmit = async (event) => {
    event.preventDefault()
    const form = event.currentTarget,
      button = form.querySelector('button')
    button.disabled = true
    button.textContent = '正在登录…'
    try {
      const data = new FormData(form)
      await api('/api/login', 'POST', {
        username: data.get('username'),
        password: data.get('password'),
      })
      await refresh(true)
    } catch (error) {
      document.querySelector('#login-error').textContent = error.message
    } finally {
      if (button.isConnected) {
        button.disabled = false
        button.textContent = '登录用户中心 ↗'
      }
    }
  }
}
function metric(label, value, foot, accent = false) {
  const pieces = String(value).split(' ')
  return `<article class="card ${accent ? 'accent' : ''}"><div class="metric-label">${label}</div><div class="metric-number">${escape(pieces[0])}${pieces.length > 1 ? `<small>${escape(pieces.slice(1).join(' '))}</small>` : ''}</div><div class="metric-foot">${escape(foot)}</div></article>`
}
function table(users, compact = false) {
  return `<div class="table-wrap"><table class="table"><thead><tr><th>账户</th><th>状态</th><th>累计流量</th><th>在线 IP</th><th>${compact ? '最近登录' : '到期时间'}</th>${compact ? '' : '<th>操作</th>'}</tr></thead><tbody>${users.map((user) => `<tr><td><div class="account-inline"><span class="avatar">${escape(user.username.slice(0, 1).toUpperCase())}</span>${escape(user.username)}${user.role === 'admin' ? '<span class="chip">管理员</span>' : ''}</div></td><td><span class="badge ${user.active ? '' : 'off'}">${user.active ? '可用' : user.enabled ? '已到期' : '已停用'}</span></td><td>${bytes(user.total)}<div class="metric-foot">↑ ${bytes(user.upload)} · ↓ ${bytes(user.download)}</div></td><td>${user.onlineIPs.length}<div class="metric-foot">${user.onlineIPs.map(escape).join('<br>') || '当前离线'}</div></td><td>${compact ? date(user.lastLogin) : user.expiresAt ? date(user.expiresAt) : '长期有效'}</td>${compact ? '' : `<td><div class="table-actions"><button data-toggle="${user.id}" ${user.id === account.user.id ? 'disabled' : ''}>${user.enabled ? '停用' : '启用'}</button><button data-reset="${user.id}">重置密码</button><button data-expire="${user.id}">到期时间</button></div></td>`}</tr>`).join('')}</tbody></table></div>`
}
function chart(samples) {
  const values = samples
    .slice(1)
    .map(
      (sample, index) =>
        Math.max(0, sample.download - samples[index].download) /
        Math.max(1, sample.at - samples[index].at),
    )
  if (values.length < 2)
    return '<div class="empty">正在收集实时流量，稍后会显示趋势</div>'
  const maximum = Math.max(...values, 1024)
  const points = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * 680).toFixed(1)},${(145 - (v / maximum) * 120).toFixed(1)}`,
    )
    .join(' ')
  return `<svg class="chart" viewBox="0 0 680 165" preserveAspectRatio="none" role="img" aria-label="最近一小时下载速率趋势"><path class="chart-grid" d="M0 25H680M0 65H680M0 105H680M0 145H680"/><polygon class="chart-area" points="0,165 ${points} 680,165"/><polyline class="chart-line" points="${points}"/></svg><div class="chart-caption"><span>过去一小时</span><span>下载速率 · 峰值 ${rate(maximum)}</span><span>现在</span></div>`
}
function dashboard() {
  if (account.user.role !== 'admin')
    return `<div class="grid">${metric('我的累计流量', bytes(account.user.total), '上传与下载之和', true)}${metric('累计下载', bytes(account.user.download), '从账户启用开始统计')}${metric('累计上传', bytes(account.user.upload), '从账户启用开始统计')}${metric('在线 IP', account.user.onlineIPs.length, '当前已认证的代理连接')}</div><section class="card section"><div class="section-head"><div><h2>你的连接已经准备好</h2><p>美国 VPS 直连 · 个人账户配置</p></div></div><p class="subtle">下载 pash 后，打开软件并使用本账户登录，即可自动配置美国节点。也可以在安装后点击下方按钮。</p><div class="activation"><div><h3>开始使用 pash</h3><p>无需手动填写服务器、端口或代理密码。</p></div><button class="button" data-page="downloads">获取安装包 ↗</button></div></section>`
  const d = overview
  if (!d) return '<div class="empty">正在读取服务器数据…</div>'
  return `<div class="grid">${metric('账户总数', d.accounts, `${d.activeAccounts} 个可用 · ${d.onlineAccounts} 个在线`)}${metric('代理在线 IP', d.proxyOnlineIPs, `${d.managedOnlineIPs} 个受管来源 · ${d.inboundOnlineIPs} 个全部入站来源`)}${metric('受管账户累计流量', bytes(d.managedTraffic.total), '上传 + 下载 · 独立凭据统计', true)}${metric('VPS 当前网络速率', rate(d.rates.received + d.rates.sent), '整台服务器网卡收发速率')}</div><div class="traffic-layout section"><section class="card"><div class="section-head"><div><h2>实时流量</h2><p>受管代理 · 每 3 秒刷新</p></div><span class="chip">LIVE</span></div><div class="rate-row"><div><div class="rate-label"><span class="dot down"></span>下载</div><div class="rate-value">${rate(d.rates.download)}</div></div><div><div class="rate-label"><span class="dot"></span>上传</div><div class="rate-value">${rate(d.rates.upload)}</div></div></div>${chart(d.samples)}</section><section class="card"><div class="section-head"><h2>服务器用量</h2></div><div class="details"><div class="detail-row"><span>账户累计下载</span><strong>${bytes(d.managedTraffic.download)}</strong></div><div class="detail-row"><span>账户累计上传</span><strong>${bytes(d.managedTraffic.upload)}</strong></div><div class="detail-row divider"><span>VPS 网卡累计接收</span><strong>${bytes(d.serverNetwork.received)}</strong></div><div class="detail-row"><span>VPS 网卡累计发送</span><strong>${bytes(d.serverNetwork.sent)}</strong></div><div class="detail-row"><span>VPS 网卡合计</span><strong>${bytes(d.serverNetwork.received + d.serverNetwork.sent)}</strong></div></div><p class="meta-note">网卡累计为本次系统启动以来的读数，包含代理、网页、SSH 等流量。账户用量自 ${date(d.monitorStarted)} 起统计，不含旧入口的历史流量。</p></section></div><section class="card section"><div class="section-head"><div><h2>账户概况</h2><p>用量与当前连接来源</p></div><button class="button light small" data-page="users">管理账户 ↗</button></div>${table(d.users, true)}</section><section class="card section"><div class="section-head"><h2>当前入站来源 IP</h2><span class="chip">${d.inboundOnlineIPs} 个来源</span></div>${
    Object.entries(d.inboundIPs.all)
      .map(
        ([ip, n]) =>
          `<div class="list-row"><span>${escape(ip)}</span><small>${n} 条连接</small></div>`,
      )
      .join('') || '<div class="empty">当前没有入站连接</div>'
  }<p class="meta-note">统计代理 443 / 4443、用户平台 8443 与 SSH 23522 的已建立连接；同一公网 IP 会合并计数。</p></section>`
}
function downloads() {
  const release = account.release
  return `<div class="download-grid">${[
    ['aarch64', 'Apple Silicon', 'M1、M2、M3、M4、M5 等 Apple 芯片'],
    ['x86_64', 'Intel Mac', '采用 Intel 处理器的 Mac'],
  ]
    .map(
      ([arch, title, detail]) =>
        `<article class="card download-card"><span class="chip">macOS · ${arch === 'aarch64' ? 'ARM64' : 'X86_64'}</span><h2>${title}</h2><p>适用于${detail}。<br>安装包内置美国服务地址，登录即可自动配置。</p>${release?.assets?.[arch] ? `<a class="button" href="/download/${arch}">下载安装包 ↓</a><p class="meta-note">pash ${escape(release.version)} · macOS 13.5 或更新版本</p>` : '<button class="button" disabled>安装包构建中</button>'}</article>`,
    )
    .join(
      '',
    )}</div><section class="card section"><div class="section-head"><h2>三步，开始连接</h2></div><div class="steps"><div class="step"><div class="step-num">1</div><h3>安装 pash</h3><p>打开 DMG，将 pash 拖入 Applications 文件夹。</p></div><div class="step"><div class="step-num">2</div><h3>登录或一键配置</h3><p>在 pash 的账户页使用同一用户名和密码登录，或点击下方按钮。</p></div><div class="step"><div class="step-num">3</div><h3>直接连接美国</h3><p>个人代理配置会自动启用，之后软件更新会保留配置。</p></div></div><div class="activation"><div><h3>已经安装了 pash？</h3><p>打开软件并导入你的个人配置，自动启用美国直连。</p></div><a class="button" href="${escape(account.activationUrl)}">打开 pash 并配置 ↗</a></div><p class="meta-note">需要 pash 0.1.3 或更新版本。<a href="${escape(account.subscriptionUrl)}">下载个人 YAML 配置</a>也可用于手动导入。</p></section>`
}
function security() {
  return `<section class="card security-form"><div class="section-head"><div><h2>修改登录密码</h2><p>修改后其他设备的登录状态会失效</p></div></div><form id="password-form"><label class="field">当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field">新密码<input name="password" type="password" autocomplete="new-password" minlength="10" required placeholder="至少 10 个字符"></label><label class="field">确认新密码<input name="confirm" type="password" autocomplete="new-password" minlength="10" required></label><div class="error" id="password-error"></div><button class="button" type="submit">保存新密码</button></form><button class="button light section" data-logout>退出登录</button></section>`
}
function render() {
  const admin = account.user.role === 'admin'
  const titles = {
    dashboard: '连接概览',
    users: '账户管理',
    downloads: '下载 pash',
    security: '账户安全',
  }
  const labels = {
    dashboard: '概览',
    users: '账户',
    downloads: '下载',
    security: '安全',
  }
  const pages = admin
    ? ['dashboard', 'users', 'downloads', 'security']
    : ['dashboard', 'downloads', 'security']
  root.innerHTML = `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">WORKSPACE</div><nav class="nav">${pages.map((name) => `<button class="${page === name ? 'active' : ''}" data-page="${name}">${svg(name)}${labels[name]}</button>`).join('')}</nav><div class="side-bottom"><div class="person"><span class="avatar">${escape(account.user.username[0].toUpperCase())}</span><div>${escape(account.user.username)}<small>${admin ? '管理员' : '个人账户'}</small></div></div><button class="logout" data-logout>退出登录 ↗</button></div></aside><main class="main"><header class="topbar"><div><h1>${titles[page]}</h1><p class="subtle">${admin ? '管理你的用户与美国 VPS 连接' : '你的个人网络与使用情况'}</p></div><span class="status ${account.nodeHealthy ? '' : 'off'}">${account.nodeHealthy ? '美国节点运行正常' : '节点数据暂不可用'}</span></header><div id="content">${page === 'dashboard' ? dashboard() : page === 'users' ? `<section class="card"><div class="section-head"><div><h2>全部账户</h2><p>${overview?.accounts || 0} 个账户 · 新增、停用与重置登录密码</p></div><button class="button small" id="create-user">＋ 新建账户</button></div>${table(overview?.users || [])}</section>` : page === 'downloads' ? downloads() : security()}</div></main></div>`
  wire()
}
function modal(html, callback) {
  const element = document.createElement('div')
  element.className = 'modal-backdrop'
  element.innerHTML = `<section class="modal" role="dialog" aria-modal="true">${html}</section>`
  document.body.append(element)
  element
    .querySelectorAll('[data-close]')
    .forEach((button) => (button.onclick = () => element.remove()))
  element.onclick = (event) => {
    if (event.target === element) element.remove()
  }
  element.querySelector('input')?.focus()
  callback?.(element)
}
function showCredentials(username, password) {
  modal(
    `<h2>账户已准备好</h2><p class="subtle">将登录信息交给用户。密码只在这里显示。</p><div class="credentials">用户名：<code>${escape(username)}</code><br>密码：<code>${escape(password)}</code></div><div class="modal-actions"><button class="button secondary" id="copy-credentials">复制登录信息</button><button class="button" data-close>完成</button></div>`,
    (element) => {
      element.querySelector('#copy-credentials').onclick = async () => {
        await navigator.clipboard.writeText(
          `用户名：${username}\n密码：${password}\n登录地址：${location.origin}`,
        )
        toast('登录信息已复制')
      }
    },
  )
}
function wire() {
  document.querySelectorAll('[data-page]').forEach(
    (button) =>
      (button.onclick = () => {
        page = button.dataset.page
        render()
      }),
  )
  document.querySelectorAll('[data-logout]').forEach((button) => {
    button.onclick = async () => {
      await api('/api/logout', 'POST', {})
      account = null
      renderLogin()
    }
  })
  document.querySelector('#create-user')?.addEventListener('click', () => {
    modal(
      '<h2>新建账户</h2><p class="subtle">用户登录后即可下载软件并获取个人配置。</p><form id="new-user"><label class="field">用户名<input name="username" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" placeholder="例如 alice"></label><label class="field">初始密码<input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="留空则自动生成"></label><label class="field">权限<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label><label class="field">到期日期<input name="expires" type="date"></label><div class="error"></div><div class="modal-actions"><button class="button light" type="button" data-close>取消</button><button class="button" type="submit">创建账户</button></div></form>',
      (element) => {
        element.querySelector('form').onsubmit = async (event) => {
          event.preventDefault()
          const form = event.currentTarget,
            values = new FormData(form),
            button = form.querySelector('[type="submit"]')
          button.disabled = true
          try {
            const result = await api('/api/admin/users', 'POST', {
              username: values.get('username'),
              password: values.get('password') || undefined,
              role: values.get('role'),
              expiresAt: values.get('expires')
                ? Math.floor(
                    new Date(values.get('expires') + 'T23:59:59').getTime() /
                      1000,
                  )
                : 0,
            })
            element.remove()
            await refresh(true)
            showCredentials(result.user.username, result.password)
          } catch (error) {
            element.querySelector('.error').textContent = error.message
            button.disabled = false
          }
        }
      },
    )
  })
  document.querySelectorAll('[data-toggle]').forEach(
    (button) =>
      (button.onclick = async () => {
        const user = overview.users.find((u) => u.id === button.dataset.toggle)
        modal(
          `<h2>${user.enabled ? '停用' : '启用'} ${escape(user.username)}？</h2><p class="subtle">${user.enabled ? '该账户将无法登录或继续使用代理，现有代理连接也会断开。' : '账户可以重新登录并使用原有配置。'}</p><div class="modal-actions"><button class="button light" data-close>取消</button><button class="button" id="confirm-toggle">确认${user.enabled ? '停用' : '启用'}</button></div>`,
          (element) => {
            element.querySelector('#confirm-toggle').onclick = async (
              event,
            ) => {
              event.currentTarget.disabled = true
              try {
                await api('/api/admin/users/' + user.id, 'PATCH', {
                  enabled: !user.enabled,
                })
                element.remove()
                await refresh(true)
                toast('账户已更新')
              } catch (error) {
                toast(error.message)
                event.currentTarget.disabled = false
              }
            }
          },
        )
      }),
  )
  document.querySelectorAll('[data-reset]').forEach(
    (button) =>
      (button.onclick = () => {
        const user = overview.users.find((u) => u.id === button.dataset.reset)
        modal(
          `<h2>重置 ${escape(user.username)} 的密码？</h2><p class="subtle">旧密码和旧代理配置会失效。用户需使用新密码重新登录 pash。</p><div class="modal-actions"><button class="button light" data-close>取消</button><button class="button" id="confirm-reset">重置密码</button></div>`,
          (element) => {
            element.querySelector('#confirm-reset').onclick = async () => {
              try {
                const result = await api(
                  '/api/admin/users/' + user.id,
                  'PATCH',
                  { resetPassword: true },
                )
                element.remove()
                showCredentials(user.username, result.password)
                await refresh(true)
              } catch (error) {
                toast(error.message)
              }
            }
          },
        )
      }),
  )
  document.querySelectorAll('[data-expire]').forEach(
    (button) =>
      (button.onclick = () => {
        const user = overview.users.find((u) => u.id === button.dataset.expire)
        modal(
          `<h2>账户有效期</h2><p class="subtle">${escape(user.username)} · 留空表示长期有效。</p><form id="expire-form"><label class="field">到期日期<input type="date" name="expires"></label><div class="modal-actions"><button class="button light" type="button" data-close>取消</button><button class="button" type="submit">保存</button></div></form>`,
          (element) => {
            element.querySelector('form').onsubmit = async (event) => {
              event.preventDefault()
              try {
                const value = new FormData(event.currentTarget).get('expires')
                await api('/api/admin/users/' + user.id, 'PATCH', {
                  expiresAt: value
                    ? Math.floor(new Date(value + 'T23:59:59').getTime() / 1000)
                    : 0,
                })
                element.remove()
                await refresh(true)
              } catch (error) {
                toast(error.message)
              }
            }
          },
        )
      }),
  )
  document
    .querySelector('#password-form')
    ?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const form = event.currentTarget,
        values = new FormData(form),
        errorElement = document.querySelector('#password-error')
      if (values.get('password') !== values.get('confirm')) {
        errorElement.textContent = '两次输入的新密码不一致'
        return
      }
      try {
        await api('/api/password', 'POST', {
          currentPassword: values.get('currentPassword'),
          password: values.get('password'),
        })
        form.reset()
        errorElement.textContent = ''
        toast('密码已更新')
      } catch (error) {
        errorElement.textContent = error.message
      }
    })
}
async function refresh(full = false) {
  if (updating) return
  updating = true
  try {
    account = await api('/api/me')
    if (account.user.role === 'admin')
      overview = await api('/api/admin/overview')
    if (full || !document.querySelector('.shell')) render()
    else if (page === 'dashboard' || page === 'users') {
      const focused = document.activeElement
      if (
        !document.querySelector('.modal-backdrop') &&
        window.getSelection()?.isCollapsed !== false &&
        (!focused || focused.tagName !== 'INPUT')
      )
        render()
    }
  } catch (error) {
    if (!account) renderLogin()
    else toast(error.message)
  } finally {
    updating = false
  }
}
await refresh(true)
setInterval(() => {
  if (account && !document.hidden) refresh()
}, 3000)
