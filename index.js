require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const { askAI } = require("./ai");

// ----------------- CONFIG -----------------
const ownerNumber = process.env.OWNER_NUMBER || "6285122173013"; // tanpa @s.whatsapp.net
const ownerJid = ownerNumber + "@s.whatsapp.net";
const startTime = Date.now();
const stickerFolder = "./temp_sticker";
const statusSaveFolder = "./statuses"; // folder untuk menyimpan status yang diunduh
if (!fs.existsSync(stickerFolder)) fs.mkdirSync(stickerFolder, { recursive: true });
if (!fs.existsSync(statusSaveFolder)) fs.mkdirSync(statusSaveFolder, { recursive: true });

// Kontrol notifikasi ke user yang meminta
// jika true => bot akan memberi tahu user bahwa media sudah dikirim ke owner
// jika false => bot akan silent (tidak memberi tahu peminta)
const NOTIFY_REQUESTER = process.env.NOTIFY_REQUESTER ? process.env.NOTIFY_REQUESTER === "true" : true;

function runtime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h} Jam ${m} Menit ${s} Detik`;
}

function isOwner(msg) {
  const sender = msg.key.participant || msg.key.remoteJid;
  return sender.replace(/[^0-9]/g, "") === ownerNumber;
}

function isAdminInGroup(participants, sender) {
  const adminIds = participants
    .filter((p) => p.admin === "admin" || p.admin === "superadmin")
    .map((a) => a.id);
  return adminIds.includes(sender);
}

// ----------------- ANTI-DELETE CACHE -----------------
// deletedCache: menyimpan pesan masuk indexed by message id
// per-chat lastDeleted disimpan di key: `${jid}_lastDeleted`
const deletedCache = {};
const MAX_CACHE_ENTRIES = 1000; // batas kasar cache agar gak memakan memory tak terbatas

function cachePut(messageId, msg) {
  try {
    deletedCache[messageId] = msg;
    // trim cache bila melebihi batas
    const keys = Object.keys(deletedCache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      // hapus entri paling lama (sederhana: hapus beberapa pertama)
      for (let i = 0; i < keys.length - MAX_CACHE_ENTRIES; i++) {
        delete deletedCache[keys[i]];
      }
    }
  } catch (e) { /* ignore */ }
}

function cacheGet(messageId) {
  return deletedCache[messageId];
}

async function startBot() {
  const authFolder = "./auth";
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    version
  });

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "open") console.log("✅ Bot Connected!");
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log("❌ Session expired. Scan ulang.");
        process.exit(0);
      } else {
        console.log("⚠ Reconnecting...");
        startBot();
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ================= WELCOME & GOODBYE =================
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const groupId = update.id;
      const metadata = await sock.groupMetadata(groupId).catch(() => null);
      for (const participant of update.participants) {
        if (update.action === "add") {
          const text = `👋 Selamat datang @${participant.split("@")[0]} di *${metadata?.subject || "grup ini"}*!`;
          await sock.sendMessage(groupId, { text, mentions: [participant] }).catch(console.error);
        }
        if (update.action === "remove") {
          const text = `😢 @${participant.split("@")[0]} keluar dari grup.`;
          await sock.sendMessage(groupId, { text, mentions: [participant] }).catch(console.error);
        }
        if (update.action === "promote") {
          const text = `🔼 @${participant.split("@")[0]} kini menjadi admin.`;
          await sock.sendMessage(groupId, { text, mentions: [participant] }).catch(console.error);
        }
        if (update.action === "demote") {
          const text = `🔽 @${participant.split("@")[0]} tidak lagi admin.`;
          await sock.sendMessage(groupId, { text, mentions: [participant] }).catch(console.error);
        }
      }
    } catch (e) { console.error("group-participants.update error:", e); }
  });

  // ================= ANTI DELETE: DETEKSI PEMBATALAN PESAN =================
  // Ketika seseorang menghapus pesan, Baileys biasanya mengirim update messages.update
  // dengan update.message === null; kita tangkap event ini dan simpan referensi pesan terakhir yang dihapus per chat
  sock.ev.on("messages.update", async (updates) => {
    try {
      for (const update of updates) {
        // update.key = { remoteJid, id, fromMe, participant }
        // update.update.message === null menandakan pesan dihapus
        if (update.update && update.update.message === null) {
          const msgId = update.key.id;
          const jid = update.key.remoteJid;
          const original = cacheGet(msgId);
          if (original) {
            // simpan per chat
            cachePut(`${jid}_lastDeleted`, original);
            console.log(`[ANTI-DELETE] Pesan dihapus di ${jid}, id=${msgId} — disimpan untuk .k`);
          }
        }
      }
    } catch (e) {
      console.error("messages.update (anti-delete) error:", e);
    }
  });

  // ================= MESSAGES HANDLER =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg || !msg.message) return;
      const from = msg.key.remoteJid;
      const body =
        msg.message.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.fileName ||
        "";
      const command = body.split(" ")[0].toLowerCase();
      const input = body.replace(command, "").trim();

      // ====== SIMPAN SEMUA PESAN MASUK KE CACHE (ANTIDELETE) ======
      // Hanya simpan pesan yang bukan dari bot itu sendiri
      try {
        if (!msg.key.fromMe && msg.message) {
          // cache dengan key message id supaya bisa dicari saat delete
          cachePut(msg.key.id, msg);
        }
      } catch (e) { /* ignore cache errors */ }

      // ================= MENU =================
      if (command === ".menu") {
        const menuText = `
╭───〔 🌟 MENU BOT 〕
│
│ 📌 Fitur Bot
│   *.owner*      → Info pemilik bot
│   *.bot*        → Info teknis bot
│   *.runtime*    → Info sistem & uptime
│
│ 📌 Fitur AI
│   *.ai <pertanyaan>* → Chat AI
│
│ 📌 Fitur Media
│   *.ttdl <link>*      → Download TikTok
│   *.sticker*          → Buat stiker dari gambar/video
│   *.s*                → Unduh status WhatsApp (reply status)
│
│ 📌 Fitur Grup (Admin)
│   *.setname <nama>*   → Ganti nama grup
│   *.setdesc <desc>*   → Ganti deskripsi grup
│   *.kick @user*       → Kick member
│   *.tagall*           → Mention semua member
╰────────────────
`;
        return sock.sendMessage(from, { text: menuText });
      }

      // ================= OWNER =================
      if (command === ".owner") {
        const ownerText = `
╔═════════════════════
║ 👑 OWNER BOT
╠═════════════════════
║ Nama   : Jogab Gebi
║ Nomor  : wa.me/${ownerNumber}
║ Role   : Developer
║ Akses  : Semua fitur & konfigurasi bot
╠═════════════════════
║ 💡 Tip: Gunakan fitur ini hanya jika perlu
╚═════════════════════
`;
        return sock.sendMessage(from, { text: ownerText });
      }

      // ================= BOT INFO =================
      if (command === ".bot") {
        const botText = `
╔════════════════════
║ 🤖 INFORMASI BOT
╠════════════════════
║ Nama Bot      : Wabot-X AI
║ Versi         : 1.0 Stable
║ Dibuat Dengan :
║   - Node.js ${process.version}
║   - Library : Baileys (WhatsApp API)
║   - AI Model: ${process.env.MODEL || "unknown"}
║   - Database : JSON / File system
║ Platform      : Termux / Linux / Android
╚════════════════════
`;
        return sock.sendMessage(from, { text: botText });
      }

      // ================= RUNTIME =================
      if (command === ".runtime" || command === ".uptime") {
        const seconds = (Date.now() - startTime) / 1000;
        const cpus = os.cpus();
        const cpuModel = cpus[0]?.model || "Unknown";
        const totalMem = os.totalmem() / 1024 / 1024;
        const freeMem = os.freemem() / 1024 / 1024;
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);
        const totalBar = 20;
        const filledBar = Math.round((memPercent / 100) * totalBar);
        const emptyBar = totalBar - filledBar;
        const ramBar = "█".repeat(filledBar) + "░".repeat(emptyBar);
        const platform = os.platform();
        const arch = os.arch();
        const nodeVersion = process.version;

        const runtimeText = `
╔═════════════════
║ ⏳ BOT RUNTIME
╠═════════════════
║ Uptime       : ${runtime(seconds)}
║ CPU          : ${cpuModel}
║ RAM          : ${usedMem.toFixed(0)}MB / ${totalMem.toFixed(0)}MB
║               [${ramBar}] ${memPercent}%
║ Platform     : ${platform} ${arch}
║ Node.js      : ${nodeVersion}
║ Active since : ${new Date(startTime).toLocaleString()}
╚═════════════════
`;
        return sock.sendMessage(from, { text: runtimeText });
      }

      // ================= AI =================
      if (command === ".ai") {
        if (!input) return sock.sendMessage(from, { text: "❌ Contoh: *.ai apa itu black hole?*" });
        await sock.sendMessage(from, { text: "⏳ Sedang berpikir..." });
        try {
          const result = await askAI(input);
          return sock.sendMessage(from, { text: result });
        } catch (err) {
          console.error("AI error:", err);
          return sock.sendMessage(from, { text: "❌ Terjadi kesalahan saat memproses AI" });
        }
      }

      // ================= TIKTOK =================
      if (command === ".ttdl") {
        if (!input) return sock.sendMessage(from, { text: "❌ Mana link TikTok?" });
        await sock.sendMessage(from, { text: "⏳ Memproses link..." });
        try {
          const res = await axios.post(
            "https://www.tikwm.com/api/",
            `url=${input}`,
            { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
          );
          const data = res.data.data;
          if (!data) return sock.sendMessage(from, { text: "❌ Gagal mendapatkan data video TikTok." });

          const videoUrl = data.hdplay || data.play;
          if (!videoUrl) return sock.sendMessage(from, { text: "❌ Video tidak tersedia." });

          await sock.sendMessage(from, { video: { url: videoUrl }, caption: "🎬 Video TikTok" });
        } catch (err) {
          console.error("TTDL error:", err);
          return sock.sendMessage(from, { text: "❌ Gagal memproses link TikTok." });
        }
      }

      // ================= STICKER MAKER =================
      if (command === ".sticker") {
        const mediaMsg = msg.message.imageMessage || msg.message.videoMessage;
        if (!mediaMsg) return sock.sendMessage(from, { text: "❌ Kirim gambar/video dulu lalu ketik *.sticker*" });
        try {
          const type = mediaMsg.mimetype.includes("image") ? "image" : "video";
          const stream = await downloadContentFromMessage(mediaMsg, type);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          const tempInput = path.join(stickerFolder, `temp_${Date.now()}.${type === "image" ? "jpg" : "mp4"}`);
          const tempOutput = path.join(stickerFolder, `sticker_${Date.now()}.webp`);
          fs.writeFileSync(tempInput, buffer);
          let ffmpegCmd = type === "image"
            ? `ffmpeg -i "${tempInput}" -vcodec libwebp -filter:v fps=fps=20 -lossless 1 -loop 0 -preset default -an -vsync 0 "${tempOutput}"`
            : `ffmpeg -i "${tempInput}" -vcodec libwebp -filter:v fps=fps=15,scale=512:512:force_original_aspect_ratio=decrease -loop 0 -preset default -an -vsync 0 "${tempOutput}"`;
          exec(ffmpegCmd, async (err) => {
            try { fs.unlinkSync(tempInput); } catch (e) { }
            if (err) { console.error("ffmpeg error:", err); return sock.sendMessage(from, { text: "❌ Gagal membuat stiker." }); }
            try {
              const stickerData = fs.readFileSync(tempOutput);
              await sock.sendMessage(from, { sticker: stickerData });
            } catch (e) { console.error("sticker send error:", e); await sock.sendMessage(from, { text: "❌ Gagal mengirim stiker." }); }
            finally { try { fs.unlinkSync(tempOutput); } catch (e) { } }
          });
        } catch (err) { console.error(err); return sock.sendMessage(from, { text: "❌ Terjadi kesalahan saat membuat stiker." }); }
      }

      // ================= DOWNLOAD STATUS (UPDATED) =================
      if (command === ".s") {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) return sock.sendMessage(from, { text: "❌ Balas status orang dengan perintah .s" });

        let mediaMsg = null;
        if (quoted.imageMessage) mediaMsg = quoted.imageMessage;
        else if (quoted.videoMessage) mediaMsg = quoted.videoMessage;
        else return sock.sendMessage(from, { text: "❌ Tidak ada media status yang bisa diunduh!" });

        try {
          const type = mediaMsg.mimetype.includes("image") ? "image" : "video";
          const stream = await downloadContentFromMessage(mediaMsg, type);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

          // Simpan ke folder lokal dengan nama file timestamp
          const ext = type === "image" ? ".jpg" : ".mp4";
          const filename = `${Date.now()}_${from.replace(/[^0-9]/g, "")}${ext}`;
          const filepath = path.join(statusSaveFolder, filename);
          fs.writeFileSync(filepath, buffer);

          // Kirim ke Owner (ownerJid)
          if (type === "image") {
            await sock.sendMessage(ownerJid, {
              image: buffer,
              caption: `📸 Status dari: ${from}\nDisimpan: ${filename}`
            });
          } else {
            await sock.sendMessage(ownerJid, {
              video: buffer,
              caption: `🎬 Status dari: ${from}\nDisimpan: ${filename}`
            });
          }

          // Opsi notifikasi ke peminta
          if (NOTIFY_REQUESTER) {
            await sock.sendMessage(from, { text: "✅ Status berhasil dikirim ke owner." }).catch(() => {});
          }

        } catch (e) {
          console.error("Download status error:", e);
          return sock.sendMessage(from, { text: "❌ Gagal mengunduh status. Pastikan belum kedaluwarsa atau media masih tersedia." });
        }
      }

      // ================= GROUP MANAGEMENT (ADMIN) =================
      if (command.startsWith(".setname") && from.endsWith("@g.us")) {
        const metadata = await sock.groupMetadata(from);
        const sender = msg.key.participant;
        if (!isAdminInGroup(metadata.participants, sender)) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa mengubah nama grup." });
        if (!input) return sock.sendMessage(from, { text: "❌ Contoh: .setname Nama Baru" });
        try { await sock.groupUpdateSubject(from, input); return sock.sendMessage(from, { text: "✅ Nama grup berhasil diganti!" }); }
        catch (e) { console.error(e); return sock.sendMessage(from, { text: "❌ Gagal mengganti nama grup." }); }
      }

      if (command.startsWith(".setdesc") && from.endsWith("@g.us")) {
        const metadata = await sock.groupMetadata(from);
        const sender = msg.key.participant;
        if (!isAdminInGroup(metadata.participants, sender)) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa mengubah deskripsi." });
        if (!input) return sock.sendMessage(from, { text: "❌ Contoh: .setdesc Deskripsi Baru" });
        try { await sock.groupUpdateDescription(from, input); return sock.sendMessage(from, { text: "✅ Deskripsi grup berhasil diganti!" }); }
        catch (e) { console.error(e); return sock.sendMessage(from, { text: "❌ Gagal mengganti deskripsi grup." }); }
      }

      if (command.startsWith(".kick") && from.endsWith("@g.us")) {
        const metadata = await sock.groupMetadata(from);
        const sender = msg.key.participant;
        if (!isAdminInGroup(metadata.participants, sender)) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa kick." });
        const tagged = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!tagged || tagged.length === 0) return sock.sendMessage(from, { text: "❌ Tag member yang ingin di-kick." });
        try { await sock.groupParticipantsUpdate(from, tagged, "remove"); return sock.sendMessage(from, { text: "✅ Member berhasil di-kick." }); }
        catch (e) { console.error(e); return sock.sendMessage(from, { text: "❌ Gagal kick member." }); }
      }

      if (command === ".tagall" && from.endsWith("@g.us")) {
        const metadata = await sock.groupMetadata(from);
        const sender = msg.key.participant;
        if (!isAdminInGroup(metadata.participants, sender)) return sock.sendMessage(from, { text: "❌ Hanya admin yang bisa tag all." });
        const mentions = metadata.participants.map(p => p.id);
        await sock.sendMessage(from, { text: "👥 Tag semua member!", mentions });
      }

      // ================= PERINTAH .k (KIRIM ULANG PESAN TERHAPUS MANUAL) =================
      if (command === ".k") {
        try {
          const lastDeleted = cacheGet(`${from}_lastDeleted`);
          if (!lastDeleted) {
            return sock.sendMessage(from, { text: "❌ Tidak ada pesan terhapus yang bisa dipulihkan!" });
          }

          const m = lastDeleted.message;

          // Text biasa
          if (m.conversation || m?.extendedTextMessage?.text) {
            const textContent = m.conversation || m?.extendedTextMessage?.text || "";
            return sock.sendMessage(from, { text: `♻️ Pesan Terhapus:\n\n${textContent}` });
          }

          // Image
          if (m.imageMessage) {
            try {
              const stream = await downloadContentFromMessage(m.imageMessage, "image");
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              return sock.sendMessage(from, { image: buffer, caption: "♻️ Gambar yang terhapus" });
            } catch (e) {
              console.error(".k restore image error:", e);
              return sock.sendMessage(from, { text: "❌ Gagal memulihkan gambar terhapus." });
            }
          }

          // Video
          if (m.videoMessage) {
            try {
              const stream = await downloadContentFromMessage(m.videoMessage, "video");
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              return sock.sendMessage(from, { video: buffer, caption: "♻️ Video yang terhapus" });
            } catch (e) {
              console.error(".k restore video error:", e);
              return sock.sendMessage(from, { text: "❌ Gagal memulihkan video terhapus." });
            }
          }

          // Document
          if (m.documentMessage) {
            try {
              const stream = await downloadContentFromMessage(m.documentMessage, "document");
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              const filename = m.documentMessage.fileName || `file_${Date.now()}`;
              return sock.sendMessage(from, { document: buffer, fileName: filename, mimetype: m.documentMessage.mimetype });
            } catch (e) {
              console.error(".k restore document error:", e);
              return sock.sendMessage(from, { text: "❌ Gagal memulihkan dokumen terhapus." });
            }
          }

          // Audio
          if (m.audioMessage) {
            try {
              const stream = await downloadContentFromMessage(m.audioMessage, "audio");
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              return sock.sendMessage(from, { audio: buffer, mimetype: m.audioMessage.mimetype, ptt: false });
            } catch (e) {
              console.error(".k restore audio error:", e);
              return sock.sendMessage(from, { text: "❌ Gagal memulihkan audio terhapus." });
            }
          }

          // Sticker
          if (m.stickerMessage) {
            try {
              const stream = await downloadContentFromMessage(m.stickerMessage, "sticker");
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
              return sock.sendMessage(from, { sticker: buffer });
            } catch (e) {
              console.error(".k restore sticker error:", e);
              return sock.sendMessage(from, { text: "❌ Gagal memulihkan stiker terhapus." });
            }
          }

          // Jika tipe tidak didukung
          return sock.sendMessage(from, { text: "⚠ Pesan terhapus tidak didukung atau format tidak dikenali." });

        } catch (e) {
          console.error(".k command error:", e);
          return sock.sendMessage(from, { text: "❌ Terjadi kesalahan saat memulihkan pesan terhapus." });
        }
      }

      // ================= LOG / HISTORY =================
      const senderName = msg.pushName || msg.key.participant || from.split("@")[0];
      console.log(`[${from}] ${senderName}: ${body}`);

    } catch (err) {
      console.error("messages.upsert error:", err);
    }
  });

}

startBot();
