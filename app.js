// app.js

// Importa los m�dulos necesarios para el proyecto.111
// makeWASocket: funci�n principal de Baileys para crear el socket de WhatsApp.
// useMultiFileAuthState: para guardar y cargar la sesi�n de autenticaci�n.
// DisconnectReason: para manejar las razones de desconexi�n.
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
// qrcode: para generar el c�digo QR que se muestra en la web.
import qrcode from "qrcode"
// express: para crear el servidor web.
import express from "express"
// fs, path, fileURLToPath, url: para gestionar rutas de archivos y directorios.
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// Define __dirname y __filename para m�dulos ES.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Variables globales para mantener el estado del bot.
let sock = null // El objeto principal del socket de WhatsApp.
let connectPromise = null // Promesa para evitar m�ltiples llamadas de conexi�n.

let latestQR = null // Almacena los datos del c�digo QR en base64.
let connectionStatus = "init" // Estado actual de la conexi�n.
let lastError = null // Almacena el �ltimo error de desconexi�n.
let meId = null // ID del usuario de WhatsApp conectado.
let meName = null // Nombre del usuario de WhatsApp conectado.

// =================== Store en memoria ===================
// L�gica para almacenar mensajes recientes en la memoria del servidor.
const MAX_PER_NUMBER = Number(process.env.MAX_PER_NUMBER || 500)
/** Map<numberString, Array<{summary, raw}>> */
const messageStore = new Map() // Almacena mensajes por n�mero de tel�fono.

/**
 * Almacena un mensaje en la memoria por n�mero.
 * @param {string} number - N�mero de tel�fono del remitente.
 * @param {object} entry - Objeto que contiene el mensaje resumido y en bruto.
 */
function pushToStore(number, entry) {
  if (!number) return
  const arr = messageStore.get(number) || []
  arr.push(entry)
  // Recorta si excede el l�mite para evitar un uso excesivo de memoria.
  if (arr.length > MAX_PER_NUMBER) arr.splice(0, arr.length - MAX_PER_NUMBER)
  messageStore.set(number, arr)
}
/**
 * Recupera mensajes almacenados para un n�mero dado.
 * @param {string} number - El n�mero del que se quieren recuperar mensajes.
 * @param {number} limit - El n�mero m�ximo de mensajes a devolver.
 * @returns {Array} - Lista de mensajes.
 */
function getFromStore(number, limit = 50) {
  const arr = messageStore.get(number) || []
  if (limit <= 0) return []
  return arr.slice(-limit)
}
/**
 * Elimina todos los mensajes de un n�mero del almacenamiento en memoria.
 * @param {string} number - El n�mero de tel�fono a limpiar.
 */
function clearStore(number) {
  messageStore.delete(number)
}

// =================== Utiles ===================
// Funciones de utilidad para procesar los datos de los mensajes de WhatsApp.

/**
 * Convierte un JID (WhatsApp ID) a un n�mero de tel�fono.
 * Ejemplo: "5215512345678@s.whatsapp.net" -> "5215512345678".
 * @param {string} jid - El JID de WhatsApp.
 * @returns {string} - El n�mero de tel�fono.
 */
function jidToNumber(jid = "") { return jid.split("@")[0] || "" }

/**
 * Convierte un n�mero de tel�fono a un JID de WhatsApp.
 * Ejemplo: "5215512345678" -> "5215512345678@s.whatsapp.net".
 * @param {string} num - El n�mero de tel�fono.
 * @returns {string} - El JID de WhatsApp.
 */
function numberToJid(num) {
  const clean = String(num || "").replace(/[^\d]/g, "")
  if (!clean) return null
  return `${clean}@s.whatsapp.net`
}

/**
 * Extrae el texto principal de un objeto de mensaje de WhatsApp.
 * Maneja diferentes tipos de mensajes (conversaci�n, texto extendido, pie de imagen, etc.).
 * @param {object} msg - El objeto de mensaje de WhatsApp.
 * @returns {string} - El texto del mensaje.
 */
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

/**
 * Determina el tipo de mensaje (ej. 'imageMessage', 'conversation').
 * @param {object} msg - El objeto de mensaje.
 * @returns {string} - El tipo de mensaje.
 */
function getMessageType(msg) {
  let m = msg?.message || {}
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message
  if (!m || typeof m !== "object") return "unknown"
  const keys = Object.keys(m)
  return keys[0] || "unknown"
}

/**
 * Extrae los n�meros de tel�fono mencionados en un mensaje.
 * @param {object} msg - El objeto de mensaje.
 * @returns {Array<string>} - Una lista de n�meros mencionados.
 */
function getMentions(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.conversationContextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
  const arr = ci?.mentionedJid || []
  return arr.map(jidToNumber)
}

/**
 * Extrae informaci�n sobre el mensaje al que se est� respondiendo (mensaje citado).
 * @param {object} msg - El objeto de mensaje.
 * @returns {object|undefined} - Un objeto con el tipo y texto del mensaje citado, o undefined si no hay.
 */
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

/**
 * Identifica si el mensaje contiene alg�n tipo de medio (imagen, video, audio, etc.).
 * @param {object} msg - El objeto de mensaje.
 * @returns {object} - Un objeto con banderas booleanas para cada tipo de medio.
 */
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

/**
 * Convierte una marca de tiempo (timestamp) en formato ISO 8601.
 * @param {number|string} ts - El timestamp.
 * @returns {string|undefined} - La fecha en formato ISO, o undefined.
 */
function tsToISO(ts) {
  const n = Number(ts || 0)
  return n ? new Date((n < 10_000_000_000 ? n * 1000 : n)).toISOString() : undefined
}

/**
 * Elimina propiedades con valores nulos, indefinidos o vac�os de un objeto.
 * Se utiliza para crear objetos "limpios" y m�s ligeros.
 * @param {object} obj - El objeto a limpiar.
 * @returns {object} - El objeto limpio.
 */
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

/**
 * Crea un resumen de un mensaje entrante con los datos m�s relevantes.
 * Esta es la funci�n principal que procesa un mensaje antes de almacenarlo o mostrarlo.
 * @param {object} msg - El objeto de mensaje de WhatsApp.
 * @returns {object} - Un objeto resumido y limpio.
 */
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

// =================== Conexi�n ===================
/**
 * Inicia la conexi�n con la API de WhatsApp a trav�s de Baileys.
 * Gestiona el estado de la conexi�n, los eventos y la reconexi�n.
 * @returns {Promise<void>}
 */
async function connectToWhatsApp() {
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    // Carga la sesi�n desde la carpeta 'baileys_auth' para no tener que volver a escanear.
    const { state, saveCreds } = await useMultiFileAuthState("baileys_auth")
    sock = makeWASocket({ auth: state })

    // Listener de eventos para mensajes nuevos.
    sock.ev.on("messages.upsert", async (event) => {
      try {
        if (event.type !== "notify") return
        const msg = event.messages?.[0]
        if (!msg || msg.key.fromMe) return // Ignora mensajes propios.

        const summary = summarizeMessage(msg)
        const fromNumber = summary.from?.number
        
        // Guarda en memoria y env�a a la interfaz a trav�s de SSE.
        pushToStore(fromNumber, { summary, raw: msg })
        console.dir(summary, { depth: null, colors: true })
        broadcastMsgSSE({
          isGroup: summary.chatType === "group",
          number: summary.from?.number,
          groupId: summary.group?.id || null,
          text: summary.text || "",
        })

        // L�GICA DE RESPUESTA A MENSAJES ENTRANTES.
        const chat = msg.key.remoteJid // El chat donde se recibi� el mensaje.
        const text = summary.text.toLowerCase()

        if (text.includes("hola")) {
          await sock.sendMessage(chat, { text: "�Hola! �En qu� puedo ayudarte?" })
        } else if (text.includes("precio")) {
          await sock.sendMessage(chat, { text: "El precio de nuestros productos es de $100." })
        } else if (text.includes("gracias")) {
          await sock.sendMessage(chat, { text: "�De nada! Si tienes m�s preguntas, no dudes en consultarme." })
        } else {
          // Respuesta por defecto si no se reconoce el comando.
          await sock.sendMessage(chat, { text: "Lo siento, no entiendo tu mensaje. Por favor, usa una de las siguientes palabras clave: hola, precio, gracias." })
        }
      } catch (e) {
        console.error("Error en messages.upsert:", e)
      }
    })

    // Listener para actualizar y guardar las credenciales de la sesi�n.
    sock.ev.on("creds.update", async () => {
      await saveCreds()
      meId = state?.creds?.me?.id || null
      meName = state?.creds?.me?.name || null
      broadcastSSE()
    })

    // Listener de eventos para cambios en el estado de la conexi�n.
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update

      // Maneja la generaci�n del QR si la conexi�n lo requiere.
      if (qr && connectionStatus !== "connected") {
        connectionStatus = "waiting-qr"
        qrcode.toDataURL(qr, (err, url) => {
          if (!err) {
            latestQR = url
            broadcastSSE()
          }
        })
      }

      // Maneja el estado 'open' (conectado).
      if (connection === "open") {
        meId = state?.creds?.me?.id || sock?.user?.id || null
        meName = state?.creds?.me?.name || sock?.user?.name || null
        if (meId) {
          connectionStatus = "connected"
          lastError = null
          console.log("? Vinculado como:", meId)
          latestQR = null
          broadcastSSE()
        } else {
          connectionStatus = "open-but-not-linked"
          broadcastSSE()
        }
      }

      // Maneja el estado 'close' (desconectado).
      if (connection === "close") {
        const errMsg = String(lastDisconnect?.error?.message || "")
        const status = lastDisconnect?.error?.output?.statusCode

        if (errMsg.includes("QR refs attempts ended")) {
          console.warn("?? Intentos de QR agotados. Reiniciando socket...")
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
// Configuraci�n del servidor web con Express.
const app = express()
app.use(express.static(path.join(__dirname, "public"))) // Sirve archivos est�ticos (html, css, js).
app.use(express.json()) // Habilita el an�lisis de cuerpos de solicitud JSON.

const sseClients = new Set() // Almacena los clientes conectados a trav�s de SSE.

/**
 * Endpoint para Server-Sent Events (SSE).
 * Mantiene una conexi�n abierta para enviar actualizaciones en tiempo real al cliente.
 */
app.get("/qr-events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()
  sseClients.add(res)
  sendSSE(res)   // Env�a el estado actual al cliente al conectar.
  req.on("close", () => sseClients.delete(res))
})

/**
 * Env�a una actualizaci�n de estado a un cliente SSE.
 * @param {object} res - El objeto de respuesta del cliente.
 */
function sendSSE(res) {
  res.write(`event: update\ndata: ${JSON.stringify({ latestQR, connectionStatus, lastError, meId, meName })}\n\n`)
}

/**
 * Env�a la actualizaci�n de estado a todos los clientes conectados a trav�s de SSE.
 */
function broadcastSSE() { for (const res of sseClients) sendSSE(res) }

/**
 * Env�a los datos de un mensaje nuevo a todos los clientes SSE.
 * @param {object} payload - Los datos del mensaje resumidos.
 */
function broadcastMsgSSE(payload) {
  const str = JSON.stringify(payload)
  for (const res of sseClients) res.write(`event: msg\ndata: ${str}\n\n`)
}

// ====== API extra: ver y limpiar mensajes por n�mero ======
/**
 * Endpoint para obtener los mensajes almacenados de un n�mero.
 */
app.get("/messages/:number", (req, res) => {
  const number = String(req.params.number || "").replace(/[^\d]/g, "")
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 50)))
  const raw = String(req.query.raw || "").toLowerCase() === "1"

  if (!number) return res.status(400).json({ ok: false, msg: "N�mero inv�lido" })
  const rows = getFromStore(number, limit)
  const body = rows.map(r => raw ? r.raw : r.summary)
  res.json({ ok: true, number, count: body.length, data: body })
})

/**
 * Endpoint para eliminar los mensajes almacenados de un n�mero.
 */
app.delete("/messages/:number", (req, res) => {
  const number = String(req.params.number || "").replace(/[^\d]/g, "")
  if (!number) return res.status(400).json({ ok: false, msg: "N�mero inv�lido" })
  clearStore(number)
  res.json({ ok: true, number, cleared: true })
})

// ========== API existente: enviar prueba ==========
/**
 * Endpoint para enviar un mensaje de texto de prueba a un n�mero.
 */
app.post("/send-test", async (req, res) => {
  try {
    const { to, text } = req.body || {}
    if (!sock) return res.status(503).json({ ok: false, msg: "Socket no iniciado" })
    if (!to || !text) return res.status(400).json({ ok: false, msg: "Faltan campos {to, text}" })
    const jid = numberToJid(to)
    if (!jid) return res.status(400).json({ ok: false, msg: "N�mero inv�lido" })

    await sock.sendMessage(jid, { text })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// ========== Logout en caliente ==========
/**
 * Desconecta la sesi�n de WhatsApp de manera segura y elimina los archivos de autenticaci�n.
 */
async function safeDisconnect() {
  try {
    connectionStatus = "logging-out"
    broadcastSSE()

    try { await sock?.logout?.() } catch {}
    try { sock?.end?.(true) } catch {}
    sock = null

    // Elimina la carpeta de autenticaci�n.
    try { fs.rmSync(path.join(__dirname, "baileys_auth"), { recursive: true, force: true }) } catch (e) {
      console.warn("No se pudo borrar baileys_auth:", e.message)
    }

    latestQR = null
    meId = null
    meName = null
    connectionStatus = "logged-out"
    broadcastSSE()

    await connectToWhatsApp() // Inicia una nueva conexi�n, pidiendo un nuevo QR.
    return { ok: true }
  } catch (e) {
    lastError = e?.message || String(e)
    connectionStatus = "closed"
    broadcastSSE()
    return { ok: false, msg: lastError }
  }
}

/**
 * Endpoint para cerrar sesi�n.
 */
app.post("/logout", async (_req, res) => {
  const r = await safeDisconnect()
  if (r.ok) res.status(200).json({ ok: true, msg: "Sesi�n cerrada. Generando nuevo QR..." })
  else res.status(500).json(r)
})

// Ra�z
app.get("/", (_req, res) => res.redirect("/qr.html"))

// Inicia el servidor web en el puerto 3000.
app.listen(3000, () => console.log("?? UI en http://localhost:3000/qr.html"))

// Lanza la conexi�n inicial con WhatsApp al iniciar el servidor.
connectToWhatsApp().catch((e) => console.error("Error iniciando WhatsApp:", e))