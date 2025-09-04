// public/qr.js
const qrImg = document.getElementById('qrImg')
const statusPill = document.getElementById('statusPill')
const connectedBox = document.getElementById('connectedBox')
const openButNotLinked = document.getElementById('openButNotLinked')
const refreshBtn = document.getElementById('refreshBtn')
const themeBtn = document.getElementById('themeBtn')
const jidLabel = document.getElementById('jidLabel')
const logoutBtn = document.getElementById('logoutBtn')
const leftSteps = document.getElementById('leftSteps')
const qrCard = document.getElementById('qrCard')

// Panel conectado
const connectedCard = document.getElementById('connectedCard')
const jidLabelTop = document.getElementById('jidLabelTop')
const deviceLabel = document.getElementById('deviceLabel')
const copyNumberBtn = document.getElementById('copyNumberBtn')
const testTo = document.getElementById('testTo')
const testSendBtn = document.getElementById('testSendBtn')
const logoutBtnTop = document.getElementById('logoutBtnTop')
const liveLog = document.getElementById('liveLog')

// Último mensaje UI
const lastFrom = document.getElementById('lastFrom')
const lastScope = document.getElementById('lastScope')
const lastText = document.getElementById('lastText')

// Tema con persistencia
const THEME_KEY = 'qr_theme_mode'
function applyTheme(mode){ document.documentElement.setAttribute('data-theme', mode); themeBtn.textContent = mode==='dark'?'☀️':mode==='light'?'🖥️':'🌙'; themeBtn.title=`Tema: ${mode}` }
function initTheme(){ applyTheme(localStorage.getItem(THEME_KEY) || 'auto') }
function cycleTheme(){ const cur=document.documentElement.getAttribute('data-theme')||'auto'; const next=cur==='auto'?'dark':cur==='dark'?'light':'auto'; localStorage.setItem(THEME_KEY,next); applyTheme(next) }
themeBtn.addEventListener('click', cycleTheme); initTheme()

function setStatus(text, danger=false){ statusPill.hidden=false; statusPill.textContent=text; statusPill.classList.toggle('danger', !!danger) }
function formatJid(jid){ if(!jid) return ''; const num=(jid.split('@')[0]||''); return num.startsWith('+')?num:`+${num}` }
function uiLog(text){
  if(!liveLog) return
  const line = document.createElement('div')
  line.className = 'log-line'
  const ts = new Date().toLocaleTimeString()
  line.textContent = `[${ts}] ${text}`
  liveLog.appendChild(line)
  liveLog.scrollTop = liveLog.scrollHeight
}

function applyPayload(payload){
  const { latestQR, connectionStatus, lastError, meId, meName } = payload || {}

  // Mostrar QR solo si hay y no estamos conectados
  if (connectionStatus !== 'connected' && latestQR) {
    if (qrImg.src !== latestQR) qrImg.src = latestQR
  } else {
    qrImg.removeAttribute('src')
  }

  // defaults
  connectedBox.hidden = true
  openButNotLinked.hidden = true
  connectedCard.hidden = true

  const showLoginUI = connectionStatus !== 'connected'
  if (leftSteps) leftSteps.hidden = !showLoginUI
  if (qrCard) qrCard.hidden = !showLoginUI

  switch (connectionStatus) {
    case 'connected':
      connectedBox.hidden = false
      jidLabel.textContent = meName ? `${meName} (${formatJid(meId)})` : formatJid(meId)
      setStatus('Conectado'); refreshBtn.style.display = 'none'
      connectedCard.hidden = false
      jidLabelTop.textContent = formatJid(meId)
      deviceLabel.textContent = meName ? `Dispositivo: ${meName}` : 'Dispositivo listo'
      uiLog('Conexión establecida')
      break

    case 'open-but-not-linked':
      openButNotLinked.hidden = false
      setStatus('Socket abierto · escanea el QR')
      refreshBtn.style.display = ''
      break

    case 'waiting-qr':
      setStatus('Escanea el QR')
      refreshBtn.style.display = ''
      break

    case 'reconnecting':
      setStatus('Reconectando...')
      refreshBtn.style.display = ''
      break

    case 'logged-out':
      setStatus('Sesión cerrada · vuelve a vincular', true)
      refreshBtn.style.display = ''
      break

    case 'closed':
      setStatus('Conexión cerrada', true)
      refreshBtn.style.display = ''
      break

    case 'logging-out':
      setStatus('Cerrando sesión...', true)
      refreshBtn.style.display = ''
      break

    default:
      setStatus('Inicializando...')
      refreshBtn.style.display = ''
      break
  }

  if (lastError && connectionStatus !== 'connected') setStatus(lastError, true)
}

// Recarga manual (opcional)
refreshBtn.addEventListener('click', () => location.reload())

// Logout (dos botones apuntan al mismo endpoint)
async function doLogout(){
  try {
    const res = await fetch('/logout', { method: 'POST' })
    const j = await res.json().catch(()=>({}))
    if (res.ok) { setStatus(j.msg || 'Sesión cerrada...', true); uiLog('Sesión cerrada desde UI') }
    else setStatus(j.msg || 'Error al cerrar sesión', true)
  } catch { setStatus('Error de red al cerrar sesión', true) }
}
if (logoutBtn) logoutBtn.addEventListener('click', doLogout)
if (logoutBtnTop) logoutBtnTop.addEventListener('click', doLogout)

// Copiar número vinculado
if (copyNumberBtn) {
  copyNumberBtn.addEventListener('click', async () => {
    const text = jidLabelTop?.textContent?.trim()
    try { await navigator.clipboard.writeText(text || '') ; uiLog('Número copiado al portapapeles') }
    catch { uiLog('No se pudo copiar el número') }
  })
}

// Enviar prueba
if (testSendBtn) {
  testSendBtn.addEventListener('click', async () => {
    const to = (testTo.value || '').trim()
    if (!to) { uiLog('Introduce un número destino'); return }
    try {
      const res = await fetch('/send-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text: 'Mensaje de prueba ✅' })
      })
      const j = await res.json().catch(()=>({}))
      if (res.ok && j.ok) uiLog(`Enviado mensaje de prueba a ${to}`)
      else uiLog(`Error al enviar: ${j.msg || res.statusText}`)
    } catch {
      uiLog('Error de red al enviar')
    }
  })
}

// SSE: estado y mensajes
const ev = new EventSource('/qr-events')
ev.addEventListener('update', (e) => { try { applyPayload(JSON.parse(e.data)) } catch {} })
ev.addEventListener('msg', (e) => {
  try {
    const d = JSON.parse(e.data) || {}
    const isGroup = !!d.isGroup
    const from = d.number
    lastFrom.textContent = from ? `+${from.replace(/^\+/, '')}` : '—'
    lastScope.textContent = isGroup ? `Grupo (${d.groupId || '—'})` : 'Privado'
    lastText.textContent = d.text || '(sin texto)'
    uiLog(`${isGroup ? 'GRUPO' : 'PRIVADO'} ${from}: ${d.text || '(sin texto)'}`)
  } catch {}
})
ev.onerror = () => setStatus('Conexión de estado perdida, reintentando...', true)
