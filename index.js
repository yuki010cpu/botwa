// index.js
// Main WhatsApp bot (mendukung chat pribadi & grup), limit per user, admin commands.
// Pastikan Anda juga punya verifier.js, users.json, .env seperti sebelumnya.

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const verifier = require('./verifier');
const sharp = require('sharp');

dotenv.config();

const USERS_FILE = path.resolve(__dirname, 'users.json');
const PAIRING_FILE = path.resolve(__dirname, 'pairing.json');

const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
const LIMIT_PER_DAY = parseInt(process.env.LIMIT_PER_DAY || '2', 10);
const BROWSER_HEADLESS = (process.env.BROWSER_HEADLESS || 'true') === 'true';

const UID_REGEX = /^\d{9,10}$/;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

async function ensureUsersFile() {
  try {
    await fsp.access(USERS_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(USERS_FILE, JSON.stringify({}, null, 2), 'utf8');
    log('Created users.json');
  }
}

async function readUsers() {
  await ensureUsersFile();
  const raw = await fsp.readFile(USERS_FILE, 'utf8');
  return JSON.parse(raw || '{}');
}

async function writeUsers(data) {
  await fsp.writeFile(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function now() {
  return Date.now();
}

function in24h(ms) {
  return (now() - ms) < 24 * 60 * 60 * 1000;
}

function askQuestion(q) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(q, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function randomDelay() {
  const ms = 1000 + Math.floor(Math.random() * 2000); // 1-3s
  return new Promise(r => setTimeout(r, ms));
}

async function ensurePairing() {
  try {
    await fsp.access(PAIRING_FILE, fs.constants.F_OK);
    const raw = await fsp.readFile(PAIRING_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (data.paired) {
      log('Pairing already exists.');
      return;
    }
  } catch {
    // no pairing file
  }

  const inputNumber = await askQuestion('Masukkan nomor WA owner (format 628xx...): ');
  if (!inputNumber) {
    log('No owner number provided. Skipping pairing generation.');
    return;
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
  const pairing = {
    owner: inputNumber,
    code,
    createdAt: now(),
    paired: false
  };
  await fsp.writeFile(PAIRING_FILE, JSON.stringify(pairing, null, 2), 'utf8');
  log(`Pairing code untuk nomor ${inputNumber}: ${code}`);
  log('Tunjukkan kode ini di aplikasi WhatsApp (atau simpan) untuk proses pairing. Jika menggunakan QR, pindai QR yang muncul di terminal.');
}

async function compressImage(buffer) {
  try {
    const out = await sharp(buffer).jpeg({ quality: 70 }).toBuffer();
    return out;
  } catch (e) {
    log('sharp compress failed, returning original buffer', e.message);
    return buffer;
  }
}

(async () => {
  log('Starting bot...');

  await ensureUsersFile();
  ensurePairing().catch(e => log('pairing helper error', e.message));

  const authFolder = path.resolve(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'open') {
      log('Connected to WhatsApp');
    } else if (connection === 'close') {
      log('Connection closed', lastDisconnect ? JSON.stringify(lastDisconnect) : '');
    } else if (qr) {
      log('QR code received (fallback). Pairing code helper also printed to terminal.');
    }
  });

  sock.ev.on('messages.upsert', async m => {
    try {
      if (!m.messages || !m.messages[0]) return;
      const msg = m.messages[0];
      if (!msg.message) return;
      if (msg.key && msg.key.fromMe) return; // ignore outgoing

      const remoteJid = msg.key.remoteJid; // chat id (group or personal)
      const isGroup = remoteJid && remoteJid.endsWith('@g.us');

      // participant present when group; otherwise sender is remoteJid
      const participantJid = isGroup ? (msg.key.participant || '') : remoteJid;
      // normalize sender number (strip domain)
      const senderNumber = (participantJid || remoteJid).replace(/@s.whatsapp.net|@g.us/g, '').replace(/\D/g, '');
      const senderFullJid = (participantJid || remoteJid); // full JID to mention if needed

      // get message text (support multiple message types)
      const messageContent = msg.message.conversation
        || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text)
        || (msg.message.imageMessage && msg.message.imageMessage.caption)
        || (msg.message.videoMessage && msg.message.videoMessage.caption)
        || '';
      const text = (messageContent || '').toString().trim();

      log(`Received from ${senderNumber} (group=${isGroup}) : ${text}`);

      // Admin commands: only owner can run, either in private or in group
      if (text.startsWith('/') && senderNumber === OWNER_NUMBER) {
        const parts = text.split(' ').filter(Boolean);
        const cmd = parts[0].toLowerCase();
        const targetRaw = parts[1] || '';
        const target = targetRaw.replace(/[^0-9]/g, '');
        const users = await readUsers();

        if (cmd === '/limit') {
          const t = target || senderNumber;
          const entry = users[t] || { count: 0, lastReset: 0 };
          const reply = `Limit ${t}: ${entry.count}/${LIMIT_PER_DAY}\nlastReset: ${entry.lastReset || 'never'}`;
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: reply, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: reply });
          }
          return;
        }

        if (cmd === '/reset') {
          const t = target || senderNumber;
          users[t] = { count: 0, lastReset: now() };
          await writeUsers(users);
          const reply = `Reset limit untuk ${t} berhasil.`;
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: reply, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: reply });
          }
          log(`Owner reset ${t}`);
          return;
        }

        if (cmd === '/resetall') {
          await writeUsers({});
          const reply = `Reset semua user berhasil.`;
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: reply, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: reply });
          }
          log('Owner reset all users');
          return;
        }
      }

      // Only accept numeric UID messages — anti spam
      if (!UID_REGEX.test(text)) {
        const reply = '⚠️ Kirim UID Free Fire (9-10 digit angka saja).';
        if (isGroup) {
          // mention sender so they see it's directed to them
          await sock.sendMessage(remoteJid, { text: reply, mentions: [senderFullJid] });
        } else {
          await sock.sendMessage(remoteJid, { text: reply });
        }
        return;
      }

      const uid = text;
      const users = await readUsers();

      if (!users[senderNumber]) {
        users[senderNumber] = { count: 0, lastReset: now() };
      }

      // reset if more than 24 hours
      if (!in24h(users[senderNumber].lastReset)) {
        users[senderNumber].count = 0;
        users[senderNumber].lastReset = now();
      }

      if (users[senderNumber].count >= LIMIT_PER_DAY) {
        const reply = `❌ Limit verifikasi hari ini sudah habis (${LIMIT_PER_DAY}/hari). Hubungi owner untuk tambah limit.`;
        if (isGroup) {
          await sock.sendMessage(remoteJid, { text: reply, mentions: [senderFullJid] });
        } else {
          await sock.sendMessage(remoteJid, { text: reply });
        }
        log(`Limit reached for ${senderNumber}`);
        await writeUsers(users);
        return;
      }

      // increment and save
      users[senderNumber].count += 1;
      await writeUsers(users);

      // Notify processing
      const processingText = `🔎 Memproses verifikasi UID ${uid}... Mohon tunggu.`;
      if (isGroup) {
        await sock.sendMessage(remoteJid, { text: processingText, mentions: [senderFullJid] });
      } else {
        await sock.sendMessage(remoteJid, { text: processingText });
      }

      log(`Verifying UID ${uid} for ${senderNumber}`);

      // call verifier
      const result = await verifier.verifyUID(uid, {
        headless: BROWSER_HEADLESS,
        maxCloudflareRetries: 2
      });

      if (result.success) {
        log(`UID ${uid} verification SUCCESS for ${senderNumber}`);
        const successText = `✅ Verifikasi UID ${uid} berhasil!`;
        if (result.screenshot && Buffer.isBuffer(result.screenshot)) {
          const compressed = await compressImage(result.screenshot);
          if (isGroup) {
            await sock.sendMessage(remoteJid, { image: compressed, caption: successText, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { image: compressed, caption: successText });
          }
        } else {
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: successText, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: successText });
          }
        }
      } else {
        log(`UID ${uid} verification FAILED for ${senderNumber}: ${result.message || 'unknown'}`);
        const errMsg = `❌ Verifikasi UID ${uid} gagal: ${result.message || 'Unknown error'}`;
        if (result.screenshot && Buffer.isBuffer(result.screenshot)) {
          const compressed = await compressImage(result.screenshot);
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: errMsg, mentions: [senderFullJid] });
            await sock.sendMessage(remoteJid, { image: compressed, caption: 'Screenshot saat error', mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: errMsg });
            await sock.sendMessage(remoteJid, { image: compressed, caption: 'Screenshot saat error' });
          }
        } else {
          if (isGroup) {
            await sock.sendMessage(remoteJid, { text: errMsg, mentions: [senderFullJid] });
          } else {
            await sock.sendMessage(remoteJid, { text: errMsg });
          }
        }
      }

      await randomDelay();

    } catch (e) {
      log('Message handler error:', e && e.message || e);
    }
  });

})();