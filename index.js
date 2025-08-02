// index.js — Dual Bot System (Public + Super Admin)
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const NodeCache = require("node-cache");
const pino = require("pino");
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = require("@whiskeysockets/baileys");
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const store = require('./lib/basestore')('./store', { maxMessagesPerChat: 100, memoryOnly: false });

const { Telegraf } = require("telegraf");
const axios = require('axios');

// 🔑 CONFIGURATION ===========================================
const PUBLIC_BOT_TOKEN = "8213740459:AAGCKLaw9Rgp68tmxaun5C0-2Kokgw6Dd4U";
const ADMIN_BOT_TOKEN = "7522476706:AAFuzBDvvH4j19FUjYWqGTny50hH3FSyz2M";
const SUPER_ADMIN_PIN = "111020"; // Change this for security
const OWNER_ID = "7802048261"; // Your Telegram user ID
const HELP_IMAGE_URL = "https://files.catbox.moe/urnjdz.jpg";

// Initialize both bots
const publicBot = new Telegraf(PUBLIC_BOT_TOKEN);
const adminBot = new Telegraf(ADMIN_BOT_TOKEN);

// Shared data storage
const connectedUsersFile = path.join(__dirname, 'connectedUsers.json');
let connectedUsers = fs.existsSync(connectedUsersFile) ? JSON.parse(fs.readFileSync(connectedUsersFile)) : {};
const sessions = {};
const userStates = {};
const adminSessions = new Set(); // Tracks who has admin access

function saveUsers() {
    fs.writeFileSync(connectedUsersFile, JSON.stringify(connectedUsers, null, 2));
}

// 🔄 WhatsApp Session Manager (Shared by both bots) ============
async function startWhatsAppBot(phoneNumber, telegramChatId, isAdmin = false) {
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

        // Send pairing code to appropriate bot
        if (!client.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await client.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    const bot = isAdmin ? adminBot : publicBot;
                    bot.telegram.sendMessage(telegramChatId, `🔑 Pairing Code for +${phoneNumber}:\n\`${code}\``, { parse_mode: "Markdown" });
                } catch (err) {
                    const bot = isAdmin ? adminBot : publicBot;
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

        // Message handlers
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
                const bot = isAdmin ? adminBot : publicBot;
                bot.telegram.sendMessage(telegramChatId, `✅ WhatsApp session for +${phoneNumber} is now connected.`);
            } else if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    const bot = isAdmin ? adminBot : publicBot;
                    bot.telegram.sendMessage(telegramChatId, `⚠️ Session for +${phoneNumber} disconnected. Reconnecting...`);
                    await startWhatsAppBot(phoneNumber, telegramChatId, isAdmin);
                }
            }
        });

        return { success: true };
    } catch (err) {
        console.error(`❌ Session error:`, err);
        return { success: false, error: err.message };
    }
}

// 👥 PUBLIC BOT COMMANDS ======================================

// 🏁 /start command
publicBot.command("start", async (ctx) => {
    try {
        await ctx.replyWithPhoto(HELP_IMAGE_URL, {
            caption: `🌟 *Welcome to WhatsApp Bridge Bot* 🌟\n\n` +
                     `This bot allows you to control WhatsApp through Telegram.\n\n` +
                     `📌 *Available Commands:*\n` +
                     `/pair <number> - Pair a WhatsApp number\n` +
                     `/status - Show your active sessions\n` +
                     `/broadcast <msg> - Send message to all your sessions\n` +
                     `/delsession <number> - Delete a session\n` +
                     `/restart <number> - Restart a session\n` +
                     `/send <number> <jid> <msg> - Send message via session\n` +
                     `/listgroups <number> - List groups from a session\n` +
                     `/help - Show help menu`,
            parse_mode: "Markdown"
        });
    } catch (error) {
        ctx.reply("Failed to load the help menu. Please try again.");
    }
});

// 🟢 /pair command
publicBot.command("pair", async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) return ctx.reply("Usage: /pair <whatsapp_number>\nExample: /pair 919876543210");
    
    const number = args[1].replace(/\D/g, '');
    if (number.length < 10) return ctx.reply("❌ Invalid number. Must be at least 10 digits.");
    
    ctx.reply(`⏳ Starting WhatsApp session for +${number}...`);
    const result = await startWhatsAppBot(number, ctx.chat.id, false);
    if (result.success) {
        ctx.reply(`✅ Session ready for +${number}. Pairing code sent.`);
    } else {
        ctx.reply(`❌ Failed: ${result.error}`);
    }
});

// 📋 /status command
publicBot.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const userSessions = connectedUsers[chatId];
    if (!userSessions || userSessions.length === 0) {
        return ctx.reply("😕 You have no active WhatsApp sessions. Use /pair to add one.");
    }
    
    const msg = userSessions.map((s, i) => 
        `🔢 ${i + 1}. +${s.phoneNumber}\n   📶 ${sessions[s.phoneNumber]?.user ? "Online" : "Offline"}\n   ⏱️ ${new Date(s.connectedAt).toLocaleString()}`
    ).join("\n\n");
    
    ctx.replyWithMarkdown(`📋 *Your WhatsApp Sessions*\n\n${msg}`);
});

// Other public commands (/broadcast, /restart, /send, /listgroups, /delsession, /help)
// ... (same implementation as before, but using publicBot instead of bot)

// 🔐 ADMIN BOT COMMANDS ======================================

// 🏡 /start command for admin bot
adminBot.command("start", async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (userId === OWNER_ID || adminSessions.has(userId)) {
        return showAdminDashboard(ctx);
    }
    
    await ctx.reply("🔒 *Admin Authentication Required*\n\nPlease use /admin to login.", {
        parse_mode: "Markdown"
    });
});

// 🔐 /admin command with PIN authentication
adminBot.command("admin", async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (adminSessions.has(userId) || userId === OWNER_ID) {
        return showAdminDashboard(ctx);
    }

    await ctx.reply("🔒 *Super Admin Login*\n\nPlease enter the 6-digit PIN:", {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "1", callback_data: "admin_pin_1" },
                    { text: "2", callback_data: "admin_pin_2" },
                    { text: "3", callback_data: "admin_pin_3" }
                ],
                [
                    { text: "4", callback_data: "admin_pin_4" },
                    { text: "5", callback_data: "admin_pin_5" },
                    { text: "6", callback_data: "admin_pin_6" }
                ],
                [
                    { text: "7", callback_data: "admin_pin_7" },
                    { text: "8", callback_data: "admin_pin_8" },
                    { text: "9", callback_data: "admin_pin_9" }
                ],
                [
                    { text: "0", callback_data: "admin_pin_0" },
                    { text: "⌫ Delete", callback_data: "admin_pin_del" },
                    { text: "✅ Submit", callback_data: "admin_pin_submit" }
                ]
            ]
        }
    });

    userStates[userId] = { pinAttempt: "" };
});

// Handle PIN buttons for admin bot
adminBot.action(/admin_pin_(.+)/, async (ctx) => {
    const userId = ctx.from.id.toString();
    const action = ctx.match[1];
    
    if (!userStates[userId]) {
        userStates[userId] = { pinAttempt: "" };
    }

    if (action === "del") {
        userStates[userId].pinAttempt = userStates[userId].pinAttempt.slice(0, -1);
    } else if (action === "submit") {
        if (userStates[userId].pinAttempt === SUPER_ADMIN_PIN || userId === OWNER_ID) {
            adminSessions.add(userId);
            await ctx.deleteMessage();
            await showAdminDashboard(ctx);
        } else {
            await ctx.answerCbQuery("❌ Incorrect PIN. Try again.");
            userStates[userId].pinAttempt = "";
        }
    } else {
        if (userStates[userId].pinAttempt.length < 6) {
            userStates[userId].pinAttempt += action;
        }
    }

    if (action !== "submit") {
        await ctx.editMessageText(
            `🔒 *Super Admin Login*\n\nPIN: ${'•'.repeat(userStates[userId].pinAttempt.length)}`,
            {
                parse_mode: "Markdown",
                reply_markup: ctx.update.callback_query.message.reply_markup
            }
        );
    }
});

// 🖥️ Admin Dashboard
async function showAdminDashboard(ctx) {
    const userId = ctx.from.id.toString();
    const bot = ctx.telegram.token === ADMIN_BOT_TOKEN ? adminBot : publicBot;
    
    if (!adminSessions.has(userId) && userId !== OWNER_ID) {
        return ctx.reply("❌ Unauthorized access.");
    }

    // Get statistics
    const totalUsers = Object.keys(connectedUsers).length;
    const totalSessions = Object.values(connectedUsers).reduce((acc, userSessions) => acc + userSessions.length, 0);
    const activeSessions = Object.keys(sessions).length;
    
    await bot.telegram.sendMessage(
        ctx.chat.id,
        `🛠️ *Super Admin Dashboard*\n\n` +
        `📊 *Statistics*\n` +
        `👥 Total Users: ${totalUsers}\n` +
        `📱 Total Sessions: ${totalSessions}\n` +
        `🟢 Active Sessions: ${activeSessions}\n\n` +
        `⚙️ *Admin Commands*\n` +
        `/admin_users - List all bot users\n` +
        `/admin_sessions - List all active sessions\n` +
        `/admin_broadcast - Broadcast to all users\n` +
        `/admin_pair <number> - Pair a WhatsApp number\n` +
        `/admin_control <number> - Control a WhatsApp number\n` +
        `/admin_logout - Exit admin mode`,
        { parse_mode: "Markdown" }
    );
}

// 👥 List all bot users
adminBot.command("admin_users", async (ctx) => {
    if (!verifyAdmin(ctx)) return;
    
    const userList = Object.entries(connectedUsers)
        .map(([chatId, sessions]) => 
            `👤 *User ID*: ${chatId}\n📱 *Sessions*: ${sessions.length}\n🔗 ${sessions.map(s => `+${s.phoneNumber}`).join(', ')}`
        )
        .join("\n\n");

    await ctx.replyWithMarkdown(
        `📋 *All Bot Users*\n\n${userList || "No users found."}`
    );
});

// 📱 List all active sessions
adminBot.command("admin_sessions", async (ctx) => {
    if (!verifyAdmin(ctx)) return;
    
    const sessionList = Object.entries(sessions)
        .map(([number, client]) => 
            `📱 *+${number}*\n` +
            `👤 Owner: ${findOwner(number)}\n` +
            `🆔 ${client.user?.id || 'Not connected'}\n` +
            `🔄 ${client.user?.connection || 'disconnected'}`
        )
        .join("\n\n");

    await ctx.replyWithMarkdown(
        `📋 *Active WhatsApp Sessions*\n\n${sessionList || "No active sessions."}`
    );
});

// 🔄 Pair numbers through admin bot
adminBot.command("admin_pair", async (ctx) => {
    if (!verifyAdmin(ctx)) return;
    
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) return ctx.reply("Usage: /admin_pair <whatsapp_number>");
    
    const number = args[1].replace(/\D/g, '');
    ctx.reply(`⏳ Starting WhatsApp session for +${number}...`);
    const result = await startWhatsAppBot(number, ctx.chat.id, true);
    if (result.success) {
        ctx.reply(`✅ Session ready for +${number}. Pairing code sent.`);
    } else {
        ctx.reply(`❌ Failed: ${result.error}`);
    }
});

// 🕹️ Control any WhatsApp number
adminBot.command("admin_control", async (ctx) => {
    if (!verifyAdmin(ctx)) return;
    
    const args = ctx.message.text.split(" ");
    if (args.length < 3) return ctx.reply("Usage: /admin_control <number> <command> [args]");
    
    const number = args[1].replace(/\D/g, '');
    const command = args[2];
    const client = sessions[number];
    
    if (!client) return ctx.reply(`❌ No active session for +${number}`);
    
    try {
        switch (command) {
            case "send":
                const targetJid = args[3];
                const message = args.slice(4).join(" ");
                await client.sendMessage(targetJid, { text: message });
                ctx.reply(`✅ Message sent via +${number} to ${targetJid}`);
                break;
            case "restart":
                await startWhatsAppBot(number, ctx.chat.id, true);
                ctx.reply(`✅ Session for +${number} restarted`);
                break;
            default:
                ctx.reply("❌ Unknown command. Available: send, restart");
        }
    } catch (err) {
        ctx.reply(`❌ Error: ${err.message}`);
    }
});

// 📢 Admin broadcast
adminBot.command("admin_broadcast", async (ctx) => {
    if (!verifyAdmin(ctx)) return;
    
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Usage: /admin_broadcast <message>");
    
    const message = args.slice(1).join(" ");
    const totalUsers = Object.keys(connectedUsers).length;
    let successCount = 0;
    
    await ctx.replyWithChatAction('typing');
    await ctx.reply(`📢 Starting broadcast to ${totalUsers} users...`);

    for (const chatId of Object.keys(connectedUsers)) {
        try {
            await publicBot.telegram.sendMessage(
                chatId, 
                `📢 *Admin Broadcast:*\n\n${message}\n\n_This is an official message from the bot admin._`,
                { parse_mode: "Markdown" }
            );
            successCount++;
        } catch (err) {
            console.log(`Failed to send to ${chatId}: ${err.message}`);
        }
    }

    await ctx.reply(
        `✅ Broadcast completed!\n\n` +
        `📩 Sent to: ${successCount} users\n` +
        `❌ Failed: ${totalUsers - successCount} users`
    );
});

// 🚪 Admin logout
adminBot.command("admin_logout", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (adminSessions.has(userId)) {
        adminSessions.delete(userId);
        await ctx.reply("🔒 You have been logged out from admin mode.");
    } else {
        await ctx.reply("❌ You're not in admin mode.");
    }
});

// 🔒 Verify admin status
function verifyAdmin(ctx) {
    const userId = ctx.from.id.toString();
    if (!adminSessions.has(userId) && userId !== OWNER_ID) {
        ctx.reply("❌ This command is only available for super admins.");
        return false;
    }
    return true;
}

// 🔍 Find owner of a WhatsApp number
function findOwner(number) {
    for (const [chatId, userSessions] of Object.entries(connectedUsers)) {
        if (userSessions.some(s => s.phoneNumber === number)) {
            return chatId;
        }
    }
    return "Unknown";
}
// ⚡ Render.com Port Binding Fix (Required!)
const http = require('http');
const PORT = process.env.PORT || 3000; // Render auto-assigns PORT

// Minimal HTTP server (for Render compliance)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 MAXTECH_XMD is running (Telegram -> WhatsApp Bridge)');
});

server.listen(PORT, () => {
  console.log(chalk.yellow(`🌐 HTTP server running on port ${PORT}`));
});

// 🚀 LAUNCH BOTS =============================================
publicBot.launch();
adminBot.launch();
console.log(chalk.green("🤖 Public bot started"));
console.log(chalk.blue("🛡️ Admin bot started"));

// 🔁 Auto Reload on Save
let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`🔁 Reloaded ${__filename}`));
    delete require.cache[file];
    require(file);
});
