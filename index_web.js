// app.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import qrcode from "qrcode"
import express from "express"

let latestQR = null
let connectionStatus = "init" // init | waiting-qr | open | reconnecting | logged-out | closed
let lastError = null

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth")
  const sock = makeWASocket({ auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      connectionStatus = "waiting-qr"
      qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
          latestQR = url
          broadcastSSE()
          console.log("📲 QR actualizado. Visita http://localhost:3000/qr")
        }
      })
    }

    if (connection === "open") {
      connectionStatus = "open"
      lastError = null
      broadcastSSE()
      console.log("✅ Bot conectado a WhatsApp")
    } else if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = status !== DisconnectReason.loggedOut
      lastError = lastDisconnect?.error?.message || null
      connectionStatus = shouldReconnect ? "reconnecting" : "logged-out"
      broadcastSSE()
      if (shouldReconnect) connectToWhatsApp().catch((e) => {
        lastError = e?.message || String(e)
        connectionStatus = "closed"
        broadcastSSE()
      })
    }
  })
}

// ---------- Servidor Express + UI tipo WhatsApp (sin caducidad visible) ----------
const app = express()

// SSE: clientes suscritos
const sseClients = new Set()
app.get("/qr-events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  sseClients.add(res)
  // snapshot inicial
  sendSSE(res)

  req.on("close", () => sseClients.delete(res))
})

function sendSSE(res) {
  const payload = { latestQR, connectionStatus, lastError }
  res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`)
}
function broadcastSSE() {
  for (const res of sseClients) sendSSE(res)
}

// Página de conexión estilo WhatsApp (sin contador)
app.get("/qr", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conectar con WhatsApp</title>
<style>
  :root {
    --bg: #0b141a; --panel: #111b21; --text: #e9edef; --muted: #8696a0;
    --brand: #00a884; --brand2: #25d366; --card: #1f2c33; --outline: #23343d;
  }
  *{box-sizing:border-box} body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;background:radial-gradient(1200px 600px at 10% -10%, #1c2a31 0%, var(--bg) 60%);color:var(--text)}
  .wrap{max-width:1100px;margin:40px auto;padding:0 20px}
  header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
  .wa{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,168,132,.35)}
  .wa svg{width:24px;height:24px;fill:#fff}
  h1{margin:0;font-size:22px}
  .panel{background:var(--panel);border:1px solid var(--outline);border-radius:16px;display:grid;grid-template-columns:1.2fr 1fr;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)}
  .left{padding:28px;border-right:1px solid var(--outline)}
  .left h2{margin:0 0 16px 0;font-size:18px}
  .steps{list-style:none;margin:0;padding:0;display:grid;gap:12px}
  .step{background:var(--card);border:1px solid var(--outline);border-radius:12px;padding:14px 14px 14px 48px;position:relative}
  .step::before{content:attr(data-n);position:absolute;left:12px;top:12px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--brand);color:#002b21;font-weight:700;font-size:12px}
  .muted{color:var(--muted)}
  .right{padding:28px;display:grid;place-items:center;background:linear-gradient(180deg,#0e171c,var(--panel))}
  .qr-card{width:320px;max-width:100%;background:#202c33;border:1px solid var(--outline);border-radius:16px;padding:16px;text-align:center}
  .qr-frame{aspect-ratio:1/1;background:#fff;border-radius:12px;display:grid;place-items:center;overflow:hidden;border:2px solid #fff}
  .qr-frame img{width:100%;height:100%;object-fit:contain}
  .pill{margin-top:12px;display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:rgba(0,168,132,.12);border:1px solid rgba(0,168,132,.35);font-size:13px;color:#aef3dc}
  .pill.danger{background:rgba(255,86,86,.12);border-color:rgba(255,86,86,.35);color:#ffd1d1}
  .btn{margin-top:14px;display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid var(--outline);background:#172229;color:var(--text);text-decoration:none;cursor:pointer;transition:transform .08s,background .15s}
  .btn:hover{background:#1a2730}.btn:active{transform:translateY(1px)}
  .connected{display:grid;gap:10px;margin-top:16px;padding:14px;border-radius:12px;background:rgba(0,168,132,.12);border:1px solid rgba(0,168,132,.35);color:#d9ffee}
  footer{margin-top:18px;color:var(--muted);font-size:12px;text-align:center}
  @media (max-width:900px){.panel{grid-template-columns:1fr}.left{border-right:0;border-bottom:1px solid var(--outline)}}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="wa" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12.04 2C6.57 2 2.13 6.44 2.13 11.91c0 2.09.6 4.02 1.64 5.65L2 22l4.59-1.7c1.58.87 3.38 1.36 5.31 1.36 5.47 0 9.91-4.44 9.91-9.91S17.51 2 12.04 2Zm5.79 14.27c-.24.67-1.39 1.28-1.93 1.33-.5.05-1.13.08-1.83-.11-.42-.11-.96-.31-1.66-.6-2.92-1.27-4.81-4.23-4.96-4.43-.15-.2-1.19-1.58-1.19-3.01 0-1.43.75-2.13 1.02-2.42.27-.29.6-.36.8-.36.2 0 .4 0 .57.01.18.01.43-.07.67.51.24.58.82 2.01.9 2.16.07.15.11.33.02.53-.09.2-.13.33-.27.5-.13.16-.29.36-.42.49-.13.13-.27.27-.12.53.15.27.68 1.12 1.46 1.82 1.01.9 1.87 1.18 2.13 1.31.27.13.43.11.59-.07.16-.18.67-.79.85-1.06.18-.27.36-.22.6-.13.24.09 1.52.72 1.78.85.27.13.44.2.51.31.07.11.07.64-.16 1.31Z"/></svg>
      </div>
      <h1>Conectar con WhatsApp</h1>
    </header>

    <section class="panel">
      <div class="left">
        <h2>Escanea el código QR</h2>
        <ul class="steps">
          <li class="step" data-n="1">Abre <strong>WhatsApp</strong> en tu teléfono.</li>
          <li class="step" data-n="2">Ve a <strong>Configuración</strong> (iPhone) o <strong>Menú</strong> (Android) <span class="muted">→</span> <strong>Dispositivos vinculados</strong>.</li>
          <li class="step" data-n="3">Toca <strong>Vincular un dispositivo</strong> y apunta al código QR.</li>
        </ul>
        <div id="connectedBox" style="display:none;" class="connected">
          <strong>✅ Conectado</strong>
          <span>Tu bot ya está vinculado. Puedes cerrar esta pestaña.</span>
        </div>
      </div>

      <div class="right">
        <div class="qr-card">
          <div class="qr-frame"><img id="qrImg" alt="QR de WhatsApp" /></div>
          <div id="statusPill" class="pill" style="display:none;"></div>
          <button class="btn" id="refreshBtn" type="button">Recargar página</button>
        </div>
      </div>
    </section>

    <footer>Hecho con Baileys · UI inspirada en WhatsApp Web (sin caducidad visible)</footer>
  </div>

<script>
  const qrImg = document.getElementById('qrImg')
  const statusPill = document.getElementById('statusPill')
  const connectedBox = document.getElementById('connectedBox')
  const refreshBtn = document.getElementById('refreshBtn')

  function setStatus(text, danger=false){
    statusPill.style.display = 'inline-flex'
    statusPill.textContent = text
    statusPill.classList.toggle('danger', !!danger)
  }

  function apply(payload){
    const { latestQR, connectionStatus, lastError } = payload

    // Mostrar QR si existe
    if (latestQR) {
      if (qrImg.src !== latestQR) qrImg.src = latestQR
    } else {
      qrImg.removeAttribute('src')
    }

    // Estados
    if (connectionStatus === 'open') {
      connectedBox.style.display = 'grid'
      setStatus('Conectado')
      document.getElementById('refreshBtn').style.display = 'none'
    } else {
      connectedBox.style.display = 'none'
      document.getElementById('refreshBtn').style.display = ''
      switch (connectionStatus) {
        case 'init': setStatus('Inicializando...'); break
        case 'waiting-qr': setStatus('Escanea el QR'); break
        case 'reconnecting': setStatus('Reconectando...'); break
        case 'logged-out': setStatus('Sesión cerrada · vuelve a vincular', true); break
        case 'closed': setStatus('Conexión cerrada', true); break
        default: setStatus('Estado desconocido')
      }
    }

    if (lastError && connectionStatus !== 'open') {
      setStatus(lastError, true)
    }
  }

  // Recarga manual (opcional)
  refreshBtn.addEventListener('click', () => location.reload())

  // Suscripción SSE
  const ev = new EventSource('/qr-events')
  ev.addEventListener('update', (e) => {
    try { apply(JSON.parse(e.data)) } catch {}
  })
  ev.onerror = () => setStatus('Conexión de estado perdida, reintentando...', true)
</script>
</body>
</html>`)
})

// Redirige raíz a /qr
app.get("/", (_, res) => res.redirect("/qr"))

app.listen(3000, () => {
  console.log("🌐 UI en http://localhost:3000/qr")
})

// Iniciar conexión a WhatsApp
connectToWhatsApp().catch((e) => console.error("Error iniciando WhatsApp:", e))
