// app.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import qrcode from "qrcode"
import express from "express"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let sock = null
let connectPromise = null

let latestQR = null
let connectionStatus = "init" // init | waiting-qr | open-but-not-linked | connected | reconnecting | logged-out | closed | logging-out
let lastError = null
let meId = null
let meName = null

// =================== Store en memoria ===================
const MAX_PER_NUMBER = Number(process.env.MAX_PER_NUMBER || 500)
/** Map<numberString, Array<{summary, raw}>> */
const messageStore = new Map()

function pushToStore(number, entry) {
  if (!number) return
  const arr = messageStore.get(number) || []
  arr.push(entry)
  // recorta si excede
  if (arr.length > MAX_PER_NUMBER) arr.splice(0, arr.length - MAX_PER_NUMBER)
  messageStore.set(number, arr)
}
function getFromStore(number, limit = 50) {
  const arr = messageStore.get(number) || []
  if (limit <= 0) return []
  return arr.slice(-limit)
}
function clearStore(number) {
  messageStore.delete(number)
}

// =================== Utiles ===================
function jidToNumber(jid = "") { return jid.split("@")[0] || "" }
function numberToJid(num) {
  const clean = String(num || "").replace(/[^\d]/g, "")
  if (!clean) return null
  return `${clean}@s.whatsapp.net`
}
function getTextFromMessage(msg) {
  const m = msg?.message || {}
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.ephemeralMessage?.message) return getTextFromMessage({ message: m.ephemeralMessage.message })
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId
  if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) return m.documentWithCaptionMessage.message.documentMessage.caption
  return ""
}
function getMessageType(msg) {
  let m = msg?.message || {}
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message
  if (!m || typeof m !== "object") return "unknown"
  const keys = Object.keys(m)
  return keys[0] || "unknown"
}
function getMentions(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.conversationContextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
  const arr = ci?.mentionedJid || []
  return arr.map(jidToNumber)
}
function getQuoted(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
  const qm = ci?.quotedMessage
  if (!qm) return undefined
  const type = Object.keys(qm)[0]
  const text =
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    qm.videoMessage?.caption ||
    ""
  return clean({
    type,
    text: text || undefined,
  })
}
function getMediaFlags(msg) {
  const m = msg?.message || {}
  const e = m.ephemeralMessage?.message || {}
  const src = Object.keys(e).length ? e : m
  return clean({
    image: !!src.imageMessage,
    video: !!src.videoMessage,
    audio: !!src.audioMessage,
    document: !!src.documentMessage,
    sticker: !!src.stickerMessage,
    location: !!src.locationMessage || !!src.liveLocationMessage,
    contact: !!src.contactMessage || !!src.contactsArrayMessage,
  })
}
function tsToISO(ts) {
  const n = Number(ts || 0)
  return n ? new Date((n < 10_000_000_000 ? n * 1000 : n)).toISOString() : undefined
}
function clean(obj) {
  if (!obj || typeof obj !== "object") return obj
  const out = Array.isArray(obj) ? [] : {}
  Object.entries(obj).forEach(([k, v]) => {
    if (v === undefined || v === null) return
    if (Array.isArray(v) && v.length === 0) return
    if (typeof v === "object" && !Array.isArray(v)) {
      const c = clean(v)
      if (c && Object.keys(c).length) out[k] = c
    } else {
      out[k] = v
    }
  })
  return out
}
function summarizeMessage(msg) {
  const remote = msg.key.remoteJid || ""
  const isGroup = remote.endsWith("@g.us")
  const text = getTextFromMessage(msg).trim()
  const msgType = getMessageType(msg)
  const summary = clean({
    chatType: isGroup ? "group" : "private",
    id: msg.key.id,
    timestamp: tsToISO(msg.messageTimestamp || msg.timestamp),
    from: clean({
      number: isGroup ? jidToNumber(msg.key.participant || "") : jidToNumber(remote),
      name: msg.pushName || undefined,
    }),
    group: isGroup ? clean({ id: jidToNumber(remote) }) : undefined,
    msgType,
    text: text || undefined,
    mentions: getMentions(msg),
    quoted: getQuoted(msg),
    media: getMediaFlags(msg),
  })
  return summary
}

// =================== Conexión ===================
async function connectToWhatsApp() {
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState("baileys_auth")
    sock = makeWASocket({ auth: state })

    // Mensajes entrantes → consola, store y SSE (NO leídos)
    sock.ev.on("messages.upsert", async (event) => {
      try {
        if (event.type !== "notify") return
        const msg = event.messages?.[0]
        if (!msg || msg.key.fromMe) return

        const summary = summarizeMessage(msg)
        const fromNumber = summary.from?.number
        // Guarda en memoria
        pushToStore(fromNumber, { summary, raw: msg })

        // Imprime en consola limpio
        console.dir(summary, { depth: null, colors: true })

        // Envía extracto a la UI
        broadcastMsgSSE({
          isGroup: summary.chatType === "group",
          number: summary.from?.number,
          groupId: summary.group?.id || null,
          text: summary.text || "",
        })

        // ❌ No marcar como leído
      } catch (e) {
        console.error("Error en messages.upsert:", e)
      }
    })

    // Persistencia de credenciales / datos de usuario
    sock.ev.on("creds.update", async () => {
      await saveCreds()
      meId = state?.creds?.me?.id || null
      meName = state?.creds?.me?.name || null
      broadcastSSE()
    })

    // Estado de conexión
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update

      // 👉 NO generes/actualices QR si ya estás conectado
      if (qr && connectionStatus !== "connected") {
        connectionStatus = "waiting-qr"
        qrcode.toDataURL(qr, (err, url) => {
          if (!err) {
            latestQR = url
            broadcastSSE()
          }
        })
      }

      if (connection === "open") {
        meId = state?.creds?.me?.id || sock?.user?.id || null
        meName = state?.creds?.me?.name || sock?.user?.name || null
        if (meId) {
          connectionStatus = "connected"
          lastError = null
          console.log("✅ Vinculado como:", meId)
          latestQR = null
          broadcastSSE()
        } else {
          connectionStatus = "open-but-not-linked"
          broadcastSSE()
        }
      }

      if (connection === "close") {
        const errMsg = String(lastDisconnect?.error?.message || "")
        const status = lastDisconnect?.error?.output?.statusCode

        if (errMsg.includes("QR refs attempts ended")) {
          console.warn("⚠️ Intentos de QR agotados. Reiniciando socket...")
          try { sock?.end?.(true) } catch {}
          sock = null
          connectionStatus = "waiting-qr"
          broadcastSSE()
          setTimeout(() => {
            connectToWhatsApp().catch(e => {
              lastError = e?.message || String(e)
              connectionStatus = "closed"
              broadcastSSE()
            })
          }, 750)
          return
        }

        const shouldReconnect = status !== DisconnectReason.loggedOut
        lastError = lastDisconnect?.error?.message || null
        connectionStatus = shouldReconnect ? "reconnecting" : "logged-out"
        broadcastSSE()
        if (shouldReconnect) {
          connectToWhatsApp().catch((e) => {
            lastError = e?.message || String(e)
            connectionStatus = "closed"
            broadcastSSE()
          })
        }
      }
    })
  })().finally(() => { connectPromise = null })
  return connectPromise
}

// =================== Express + SSE ===================
const app = express()
app.use(express.static(path.join(__dirname, "public")))
app.use(express.json())

const sseClients = new Set()
app.get("/qr-events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()
  sseClients.add(res)
  sendSSE(res)   // snapshot de estado
  req.on("close", () => sseClients.delete(res))
})

function sendSSE(res) {
  res.write(`event: update\ndata: ${JSON.stringify({ latestQR, connectionStatus, lastError, meId, meName })}\n\n`)
}
function broadcastSSE() { for (const res of sseClients) sendSSE(res) }
function broadcastMsgSSE(payload) {
  const str = JSON.stringify(payload)
  for (const res of sseClients) res.write(`event: msg\ndata: ${str}\n\n`)
}

// ====== API extra: ver y limpiar mensajes por número ======
app.get("/messages/:number", (req, res) => {
  const number = String(req.params.number || "").replace(/[^\d]/g, "")
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 50)))
  const raw = String(req.query.raw || "").toLowerCase() === "1"

  if (!number) return res.status(400).json({ ok: false, msg: "Número inválido" })
  const rows = getFromStore(number, limit)
  const body = rows.map(r => raw ? r.raw : r.summary)
  res.json({ ok: true, number, count: body.length, data: body })
})

app.delete("/messages/:number", (req, res) => {
  const number = String(req.params.number || "").replace(/[^\d]/g, "")
  if (!number) return res.status(400).json({ ok: false, msg: "Número inválido" })
  clearStore(number)
  res.json({ ok: true, number, cleared: true })
})

// ========== API existente: enviar prueba ==========
app.post("/send-test", async (req, res) => {
  try {
    const { to, text } = req.body || {}
    if (!sock) return res.status(503).json({ ok: false, msg: "Socket no iniciado" })
    if (!to || !text) return res.status(400).json({ ok: false, msg: "Faltan campos {to, text}" })
    const jid = numberToJid(to)
    if (!jid) return res.status(400).json({ ok: false, msg: "Número inválido" })

    await sock.sendMessage(jid, { text })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// ========== Logout en caliente ==========
async function safeDisconnect() {
  try {
    connectionStatus = "logging-out"
    broadcastSSE()

    try { await sock?.logout?.() } catch {}
    try { sock?.end?.(true) } catch {}
    sock = null

    try { fs.rmSync(path.join(__dirname, "baileys_auth"), { recursive: true, force: true }) } catch (e) {
      console.warn("No se pudo borrar baileys_auth:", e.message)
    }

    latestQR = null
    meId = null
    meName = null
    connectionStatus = "logged-out"
    broadcastSSE()

    await connectToWhatsApp() // pedirá nuevo QR
    return { ok: true }
  } catch (e) {
    lastError = e?.message || String(e)
    connectionStatus = "closed"
    broadcastSSE()
    return { ok: false, msg: lastError }
  }
}

app.post("/logout", async (_req, res) => {
  const r = await safeDisconnect()
  if (r.ok) res.status(200).json({ ok: true, msg: "Sesión cerrada. Generando nuevo QR..." })
  else res.status(500).json(r)
})

// Raíz
app.get("/", (_req, res) => res.redirect("/qr.html"))

app.listen(3000, () => console.log("🌐 UI en http://localhost:3000/qr.html"))

// Lanzar conexión
connectToWhatsApp().catch((e) => console.error("Error iniciando WhatsApp:", e))
