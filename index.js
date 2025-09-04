import makeWASocket, { useMultiFileAuthState, DisconnectReason, getContentType } from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth")
  const sock = makeWASocket({ auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === "open") console.log("✅ Bot conectado a WhatsApp")
    else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) connectToWhatsApp()
    }
  })

  sock.ev.on("messages.upsert", async (mUpsert) => {
    const m = mUpsert.messages[0]
    if (!m || m.key.fromMe || mUpsert.type !== "notify") return

    const from = m.key.remoteJid
    const type = getContentType(m.message)
    let text = ""

    if (type === "conversation") text = m.message.conversation
    else if (type === "extendedTextMessage") text = m.message.extendedTextMessage?.text || ""
    else if (type === "imageMessage") text = m.message.imageMessage?.caption || ""
    else if (type === "videoMessage") text = m.message.videoMessage?.caption || ""

    console.log("📩", { from, type, text })

    if (text.toLowerCase().includes("hola")) {
      await sock.sendMessage(from, { text: "👋 ¡Hola! Soy tu bot con Baileys." })
    } else if (text.toLowerCase().includes("adios")) {
      await sock.sendMessage(from, { text: "👋 ¡Hasta luego!" })
    } else {
      await sock.sendMessage(from, { text: "🤖 Te oí. Escríbeme 'hola' o 'adios'." })
    }
  })
}

connectToWhatsApp()
