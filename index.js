// index.js — MAXTECH_XMD WhatsApp bot with Telegram control
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const NodeCache = require("node-cache");
const pino = require("pino");
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = require("@whiskeysockets/baileys");
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const store = require('./lib/basestore')('./store', { maxMessagesPerChat: 100, memoryOnly: false });

const { Telegraf } = require("telegraf");

// 👉 SET YOUR BOT TOKEN HERE 👇
const BOT_TOKEN = "7685908343:AAHbU1aj_vCTrPnDqMctV-zK0cP8eQvyROs";
const OWNER_ID = "7802048260"; // optional (e.g., your Telegram user ID)

const bot = new Telegraf(BOT_TOKEN);
const connectedUsersFile = path.join(__dirname, 'connectedUsers.json');
let connectedUsers = fs.existsSync(connectedUsersFile) ? JSON.parse(fs.readFileSync(connectedUsersFile)) : {};
function saveUsers() {
    fs.writeFileSync(connectedUsersFile, JSON.stringify(connectedUsers, null, 2));
}

const sessions = {};

// 🟢 /pair command
bot.command("pair", async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) return ctx.reply("Usage: /pair <whatsapp_number>");
    const number = args[1].replace(/\D/g, '');
    ctx.reply(`⏳ Starting WhatsApp session for ${number}...`);
    const result = await startWhatsAppBot(number, ctx.chat.id);
    if (result.success) {
        ctx.reply(`✅ Session ready for +${number}. Pairing code sent.`);
    } else {
        ctx.reply(`❌ Failed: ${result.error}`);
    }
});

// 📋 /status command
bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const userSessions = connectedUsers[chatId];
    if (!userSessions || userSessions.length === 0) {
        return ctx.reply("😕 You have no active WhatsApp sessions.");
    }
    const msg = userSessions.map((s, i) => `🔢 ${i + 1}. +${s.phoneNumber}`).join("\n");
    ctx.reply(`📋 Connected WhatsApp sessions:\n${msg}`);
});

// 📣 /broadcast <msg> command
bot.command("broadcast", async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Usage: /broadcast <message>");
    const chatId = ctx.chat.id;
    const userSessions = connectedUsers[chatId];
    if (!userSessions || userSessions.length === 0) {
        return ctx.reply("😕 You have no active WhatsApp sessions.");
    }

    const message = ctx.message.text.replace("/broadcast", "").trim();
    let successCount = 0;

    for (const session of userSessions) {
        const client = sessions[session.phoneNumber];
        if (!client) continue;
        try {
            await client.sendMessage(client.user.id, { text: `📢 Broadcast:\n${message}` });
            successCount++;
        } catch (e) {
            console.log(`❌ Broadcast failed to ${session.phoneNumber}`);
        }
    }

    ctx.reply(`✅ Broadcast sent to ${successCount} WhatsApp session(s).`);
});

// ❌ /delsession <number>
bot.command("delsession", async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) return ctx.reply("Usage: /delsession <whatsapp_number>");
    
    const number = args[1].replace(/\D/g, '');
    const sessionDir = path.join(__dirname, "session", number);

    if (!fs.existsSync(sessionDir)) {
        return ctx.reply(`❌ Session for +${number} does not exist.`);
    }

    const chatId = ctx.chat.id;
    if (connectedUsers[chatId]) {
        connectedUsers[chatId] = connectedUsers[chatId].filter(s => s.phoneNumber !== number);
        if (connectedUsers[chatId].length === 0) {
            delete connectedUsers[chatId];
        }
        saveUsers();
    }

    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        ctx.reply(`✅ Session for +${number} deleted.`);
    } catch (err) {
        ctx.reply(`❌ Failed to delete session:\n${err.message}`);
    }
});

// Start Telegram bot
bot.launch();
console.log(chalk.green("🤖 Telegram bot started."));

// 🔌 WhatsApp Session Loader
async function startWhatsAppBot(phoneNumber, telegramChatId) {
    try {
        const sessionDir = path.join(__dirname, "session", phoneNumber);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const client = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            markOnlineOnConnect: true,
        });

        store.bind(client.ev);
        sessions[phoneNumber] = client;

        // Send pairing code
        if (!client.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await client.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    bot.telegram.sendMessage(telegramChatId, `🔑 Pairing Code for +${phoneNumber}:\n\`${code}\``, { parse_mode: "Markdown" });
                } catch (err) {
                    bot.telegram.sendMessage(telegramChatId, `❌ Could not generate pairing code:\n${err.message}`);
                }
            }, 3000);
        }

        // Save to connectedUsers
        if (!connectedUsers[telegramChatId]) connectedUsers[telegramChatId] = [];
        if (!connectedUsers[telegramChatId].find(s => s.phoneNumber === phoneNumber)) {
            connectedUsers[telegramChatId].push({ phoneNumber, connectedAt: Date.now() });
            saveUsers();
        }

        // Handle incoming messages
        client.ev.on("messages.upsert", async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.message) return;
                if (mek.key.remoteJid === "status@broadcast") return handleStatus(client, chatUpdate);
                await handleMessages(client, chatUpdate, true);
            } catch (err) {
                console.error("⚠️ Message handler error:", err);
            }
        });

        client.ev.on("group-participants.update", async (update) => {
            await handleGroupParticipantUpdate(client, update);
        });

        client.ev.on("creds.update", saveCreds);

        client.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
            if (connection === "open") {
                console.log(chalk.blue(`✅ Connected: +${phoneNumber}`));
            } else if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    await startWhatsAppBot(phoneNumber, telegramChatId);
                }
            }
        });

        return { success: true };
    } catch (err) {
        console.error(`❌ Session error:`, err);
        return { success: false, error: err.message };
    }
}

// 🔁 Auto Reload on Save
let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`🔁 Reloaded ${__filename}`));
    delete require.cache[file];
    require(file);
});
