import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    downloadMediaMessage, 
    Browsers 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';
import { GoogleAuth } from 'google-auth-library';
import { CONFIG } from '../config.js';
import BusinessObserverMessage from '../models/BusinessObserverMessage.js';
import BusinessObserverEmployee from '../models/BusinessObserverEmployee.js';
import BusinessObserverGroup from '../models/BusinessObserverGroup.js';
import { sessions as botSessions } from '../controllers/botController.js';

const logger = pino({ level: 'silent' });

// الخريطة المركزية لجلسات المراقب الصامت حسب معرف المستخدم
const observerSessions = new Map();

// ذاكرة تخزين مؤقت لميتاداتا الجروبات لتسريع المعالجة وتفادي الحظر
const groupMetadataCache = new Map();

async function getCachedGroupMetadata(sock, jid) {
    if (!sock || !jid) return null;
    const cached = groupMetadataCache.get(jid);
    if (cached && (Date.now() - cached.timestamp < 3600000)) { // 1 ساعة
        return cached.data;
    }
    try {
        const data = await sock.groupMetadata(jid).catch(() => null);
        if (data) {
            groupMetadataCache.set(jid, { data, timestamp: Date.now() });
            return data;
        }
    } catch (_) {}
    return cached?.data || null;
}

/**
 * تنظيف رقم الهاتف ومقارنته بمرونة (آخر 10 أرقام للموبايل المصري أو العربي)
 */
export function normalizePhoneDigits(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.length >= 10) {
        return digits.slice(-10);
    }
    return digits;
}

/**
 * جلب حالة جلسة المراقب الحالية
 */
export function getObserverStatus(userId = 3) {
    const session = observerSessions.get(parseInt(userId, 10)) || observerSessions.get(String(userId));
    if (!session) {
        // فحص هل الجلسة موجودة على القرص
        const authPath = path.join(process.cwd(), 'sessions', `observer_${parseInt(userId, 10)}`);
        const isAuthSaved = fs.existsSync(path.join(authPath, 'creds.json'));
        return {
            status: isAuthSaved ? 'connecting' : 'disconnected',
            phone: null,
            name: null,
            qr: null,
            pairingCode: null
        };
    }
    return {
        status: session.status || 'disconnected',
        phone: session.phone || null,
        name: session.name || null,
        qr: session.qr || null,
        pairingCode: session.pairingCode || null
    };
}

/**
 * تحويل التسجيل الصوتي إلى نص بالعامية المصرية باستخدام Gemini Multimodal
 */
async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/ogg') {
    if (!audioBuffer || audioBuffer.length === 0) return null;
    try {
        const url = CONFIG.getVertexUrl();
        const cleanMime = mimeType.split(';')[0] || 'audio/ogg';

        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inline_data: {
                                mime_type: cleanMime,
                                data: audioBuffer.toString("base64")
                            }
                        },
                        {
                            text: "أنت مفرغ صوتي محترف. فرغ هذا التسجيل الصوتي بالعامية المصرية بدقة واكتب النص المنطوق فقط بدون أي مقدمات أو شروحات."
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                topP: 0.8
            }
        };

        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'fast-order-505012-2adde4c0badf.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken.token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('❌ [Observer Audio Transcribe] API Error:', err);
            return null;
        }

        const data = await response.json();
        const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text && !p.thought) || data.candidates?.[0]?.content?.parts?.[0];
        const result = (textPart?.text || '').trim();
        return result || null;
    } catch (e) {
        console.error('❌ [Observer Audio Transcribe] Error:', e.message);
        return null;
    }
}

/**
 * بدء وتشغيل جلسة المراقب الصامت
 */
export async function startObserverSession(userId = 3, phoneNumber = null, io = null) {
    const uId = parseInt(userId, 10);
    console.log(`🕵️‍♂️ [Observer] Starting session for User ${uId}... Phone: ${phoneNumber || 'QR / Restore mode'}`);

    // إيقاف وتنظيف أي سوكت سابق
    const existing = observerSessions.get(uId);
    if (existing && existing.sock) {
        try {
            if (existing.sock.ev) existing.sock.ev.removeAllListeners();
            if (typeof existing.sock.end === 'function') existing.sock.end(undefined);
        } catch (_) {}
    }

    const authPath = path.join(process.cwd(), 'sessions', `observer_${uId}`);
    if (phoneNumber) {
        // عند طلب كود ربط جديد، ننظف مجلد الجلسة للحصول على كود جديد تماماً
        try {
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
        } catch (_) {}
    }

    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sessionData = {
        sock: null,
        status: 'connecting',
        phone: null,
        name: null,
        qr: null,
        pairingCode: null
    };
    observerSessions.set(uId, sessionData);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false
    });

    sessionData.sock = sock;

    // حفظ بيانات الاعتماد
    sock.ev.on('creds.update', saveCreds);

    // طلب كود الربط إذا تم إدخال رقم هاتف
    if (phoneNumber && !sock.authState.creds.registered) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        setTimeout(async () => {
            try {
                console.log(`🕵️‍♂️ [Observer] Requesting pairing code for: ${cleanPhone}`);
                const code = await sock.requestPairingCode(cleanPhone);
                console.log(`🕵️‍♂️ [Observer] Pairing Code generated: ${code}`);
                sessionData.status = 'pairing_code';
                sessionData.pairingCode = code;
                if (io) {
                    io.to(`user_${uId}`).emit('observer_pairing_code', { code });
                }
            } catch (err) {
                console.error("❌ [Observer] Pairing Code Error:", err);
                sessionData.status = 'error';
                if (io) {
                    io.to(`user_${uId}`).emit('observer_error', { message: 'فشل توليد كود الربط: ' + err.message });
                }
            }
        }, 1500);
    }

    // مراقبة تحديثات الاتصال
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) {
            sessionData.status = 'qr';
            sessionData.qr = qr;
            if (io) {
                io.to(`user_${uId}`).emit('observer_qr', { qr });
            }
        }

        if (connection === 'open') {
            const rawPhone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
            sessionData.status = 'connected';
            sessionData.phone = rawPhone;
            sessionData.name = sock.user?.name || 'مراقب الأعمال';
            sessionData.qr = null;
            sessionData.pairingCode = null;

            console.log(`✅ [Observer] Connected successfully as ${rawPhone} (${sessionData.name})`);

            // جلب وطباعة كل الجروبات المشارك فيها الحساب فورياً للمطابقة
            try {
                const parts = await sock.groupFetchAllParticipating();
                if (parts) {
                    const groupNames = [];
                    for (const [jid, g] of Object.entries(parts)) {
                        groupMetadataCache.set(jid, { data: g, timestamp: Date.now() });
                        groupNames.push(g.subject || jid);
                    }
                    console.log(`📋 [Observer Groups (${groupNames.length})]:\n${groupNames.map(n => '  - ' + n).join('\n')}`);
                }
            } catch (gErr) {
                console.error('❌ [Observer Group Fetch Error]:', gErr.message);
            }
            if (io) {
                io.to(`user_${uId}`).emit('observer_status', {
                    status: 'connected',
                    phone: rawPhone,
                    name: sessionData.name
                });
            }
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ [Observer] Connection closed. Reason:`, lastDisconnect?.error?.message, `Should reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                sessionData.status = 'connecting';
                if (io) {
                    io.to(`user_${uId}`).emit('observer_status', { status: 'connecting' });
                }
                setTimeout(() => startObserverSession(uId, null, io), 5000);
            } else {
                sessionData.status = 'disconnected';
                sessionData.phone = null;
                sessionData.name = null;
                sessionData.qr = null;
                sessionData.pairingCode = null;
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                } catch (_) {}
                if (io) {
                    io.to(`user_${uId}`).emit('observer_status', { status: 'disconnected' });
                }
            }
        }
    });

    // مراقبة الرسائل الواردة والصادرة وتسجيلها صامتاً (Zero-Interaction)
    sock.ev.on('messages.upsert', async (upsert) => {
        try {
            if (!upsert.messages || upsert.messages.length === 0) return;
            console.log(`📨 [Observer Event] Upsert type: ${upsert.type} | Count: ${upsert.messages.length} | JID: ${upsert.messages[0]?.key?.remoteJid}`);

            for (const msg of upsert.messages) {
                const remoteJid = msg.key?.remoteJid || '';
                console.log(`🔍 [Observer Msg Debug] JID: ${remoteJid} | Keys in msg.message: ${Object.keys(msg.message || {})}`);
                if (!remoteJid || remoteJid === 'status@broadcast') continue;

                const messageId = msg.key?.id;
                if (!messageId) continue;

                // فحص نوع الرسالة والوسائط
                const actualMsg = msg.message?.ephemeralMessage?.message || 
                    msg.message?.viewOnceMessage?.message || 
                    msg.message?.viewOnceMessageV2?.message ||
                    msg.message?.documentWithCaptionMessage?.message ||
                    msg.message || {};

                // التأكد من وجود محتوى حقيقي (نص، صوت، صورة، فيديو، ملف، لوكيشن، كونتكت)
                // استبعاد الرسائل الفارغة أو التي تحوي تفاعلات/بروتوكول فقط بدون أي محتوى
                if (actualMsg.protocolMessage && !actualMsg.conversation && !actualMsg.extendedTextMessage) continue;
                // معالجة تفاعلات الإيموجي وتحديث الرسالة الأصلية
                if (actualMsg.reactionMessage) {
                    const reaction = actualMsg.reactionMessage;
                    const targetKey = reaction.key;
                    if (targetKey && targetKey.id) {
                        const senderJid = msg.key.participant || msg.participant || (msg.key.fromMe ? sock.user?.id : remoteJid);
                        await handleMessageReaction(uId, io, {
                            targetMessageId: targetKey.id,
                            targetChatJid: targetKey.remoteJid || remoteJid,
                            emoji: reaction.text || '',
                            senderJid,
                            senderName: msg.pushName || (msg.key.fromMe ? (sessionData.name || 'م/ راضي') : null),
                            timestamp: reaction.senderTimestampMs ? new Date(Number(reaction.senderTimestampMs)) : new Date()
                        });
                    }
                    continue;
                }

                // التأكد من وجود محتوى حقيقي (نص، صوت، صورة، فيديو، ملف، لوكيشن، كونتكت)
                const hasRealContent = actualMsg.conversation || 
                    actualMsg.extendedTextMessage || 
                    actualMsg.audioMessage || 
                    actualMsg.imageMessage || 
                    actualMsg.videoMessage || 
                    actualMsg.documentMessage || 
                    actualMsg.stickerMessage ||
                    actualMsg.contactMessage ||
                    actualMsg.locationMessage;

                if (!hasRealContent) continue;

                // التحقق من عدم تسجيل الرسالة مسبقاً (Deduplication)
                const exists = await BusinessObserverMessage.findOne({
                    where: { messageId, UserId: uId }
                });
                if (exists) continue;

                const isGroup = remoteJid.endsWith('@g.us');
                const isFromMe = Boolean(msg.key.fromMe);

                // استخراج رقم واسم المرسل
                let senderJid = isFromMe 
                    ? (sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : remoteJid)
                    : (isGroup ? (msg.key.participant || msg.participant || '') : remoteJid);

                let senderPhone = senderJid ? senderJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '') : '';
                let senderName = msg.pushName || null;
                if (isFromMe && !senderName) {
                    senderName = sessionData.name || 'م/ راضي';
                }

                // استخراج اسم الشات أو الجروب
                let chatName = remoteJid;
                if (isGroup) {
                    const grp = await getCachedGroupMetadata(sock, remoteJid);
                    if (grp && grp.subject) chatName = grp.subject;
                } else {
                    chatName = senderName || senderPhone || remoteJid;
                }

                let messageType = 'text';
                let content = '';
                let mediaFileName = null;
                let mediaMimeType = null;
                let mediaSize = null;
                let mediaDuration = null;
                let mediaUrl = null;
                let transcription = null;

                if (actualMsg.conversation) {
                    messageType = 'text';
                    content = actualMsg.conversation;
                } else if (actualMsg.extendedTextMessage) {
                    messageType = 'text';
                    content = actualMsg.extendedTextMessage.text || '';
                } else if (actualMsg.audioMessage) {
                    messageType = 'audio';
                    mediaDuration = actualMsg.audioMessage.seconds || null;
                    mediaMimeType = actualMsg.audioMessage.mimetype || 'audio/ogg';
                    mediaSize = actualMsg.audioMessage.fileLength || null;
                    content = '🎙️ تسجيل صوتي (فويس نوت)';

                    // حفظ الفويس محلياً وتحويله لنص
                    try {
                        const mediaDir = path.join(process.cwd(), 'public', 'uploads', 'observer_audio', String(uId));
                        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
                        const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
                        if (audioBuffer) {
                            const fileName = `voice_${Date.now()}.ogg`;
                            const fullPath = path.join(mediaDir, fileName);
                            fs.writeFileSync(fullPath, audioBuffer);
                            mediaUrl = `/uploads/observer_audio/${uId}/${fileName}`;
                            mediaFileName = fileName;

                            // تحويل الصوت لنص مقروء بالعامية عبر Gemini
                            transcription = await transcribeAudioWithGemini(audioBuffer, mediaMimeType);
                        }
                    } catch (audioErr) {
                        console.error('❌ [Observer] Audio download/transcribe error:', audioErr.message);
                    }
                } else if (actualMsg.imageMessage) {
                    messageType = 'image';
                    mediaMimeType = actualMsg.imageMessage.mimetype || 'image/jpeg';
                    mediaSize = actualMsg.imageMessage.fileLength || null;
                    content = actualMsg.imageMessage.caption ? `📷 صورة: ${actualMsg.imageMessage.caption}` : '📷 صورة';

                    // حفظ الصورة محلياً
                    try {
                        const mediaDir = path.join(process.cwd(), 'public', 'uploads', 'observer_media', String(uId));
                        if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
                        if (imgBuffer) {
                            const fileName = `img_${Date.now()}.jpg`;
                            const fullPath = path.join(mediaDir, fileName);
                            fs.writeFileSync(fullPath, imgBuffer);
                            mediaUrl = `/uploads/observer_media/${uId}/${fileName}`;
                            mediaFileName = fileName;
                        }
                    } catch (imgErr) {
                        console.error('❌ [Observer] Image download error:', imgErr.message);
                    }
                } else if (actualMsg.videoMessage) {
                    // شرط المستخدم الصارم: الفيديوهات لا يتم تحميلها إطلاقاً بل تسجيل اسمها والميتاداتا فقط
                    messageType = 'video';
                    mediaDuration = actualMsg.videoMessage.seconds || null;
                    mediaSize = actualMsg.videoMessage.fileLength || null;
                    mediaMimeType = actualMsg.videoMessage.mimetype || 'video/mp4';
                    mediaFileName = actualMsg.videoMessage.fileName || `WhatsApp_Video_${Date.now()}.mp4`;
                    content = actualMsg.videoMessage.caption ? `🎥 فيديو: ${actualMsg.videoMessage.caption}` : `🎥 ملف فيديو: ${mediaFileName}`;
                    mediaUrl = null; // لم يتم تنزيل الفيديو لتوفير المساحة والسرعة
                } else if (actualMsg.documentMessage) {
                    messageType = 'document';
                    mediaFileName = actualMsg.documentMessage.fileName || actualMsg.documentMessage.title || 'وثيقة';
                    mediaMimeType = actualMsg.documentMessage.mimetype || 'application/octet-stream';
                    mediaSize = actualMsg.documentMessage.fileLength || null;
                    content = actualMsg.documentMessage.caption ? `📄 مستند: ${mediaFileName} (${actualMsg.documentMessage.caption})` : `📄 مستند: ${mediaFileName}`;
                } else if (actualMsg.stickerMessage) {
                    messageType = 'sticker';
                    content = '🏷️ ستيكر';
                } else if (actualMsg.locationMessage) {
                    messageType = 'other';
                    content = '📍 موقع جغرافي';
                } else if (actualMsg.contactMessage) {
                    messageType = 'other';
                    content = '👤 جهة اتصال';
                } else {
                    // استبعاد أي رسائل داخلية غير معروفة لعدم تلويث السجل
                    continue;
                }

                // مطابقة الموظف من قاعدة بيانات الموظفين المعرفين
                let matchedEmployeeName = null;
                let matchedEmployeeRole = null;

                const phoneDigits = normalizePhoneDigits(senderPhone);
                if (phoneDigits || senderPhone || senderName) {
                    const employees = await BusinessObserverEmployee.findAll({
                        where: { UserId: uId, isActive: true }
                    });
                    const matched = employees.find(e => {
                        const eNorm = normalizePhoneDigits(e.phone);
                        if (phoneDigits && eNorm && eNorm === phoneDigits) return true;
                        if (e.phone && senderPhone && (e.phone.includes(senderPhone) || senderPhone.includes(e.phone))) return true;
                        if (e.notes && senderPhone && e.notes.includes(senderPhone)) return true;
                        if (senderName && e.name) {
                            const sName = senderName.toLowerCase();
                            const eName = e.name.toLowerCase();
                            if (sName.includes(eName) || eName.includes(sName)) return true;
                            // دعم كتابة الاسم بالإنجليزي (مثل Reem -> ريم)
                            if (sName.includes('reem') && eName.includes('ريم')) return true;
                        }
                        if (senderName) {
                            const sName = senderName.toLowerCase();
                            if (sName.includes('bird technology') && e.name.includes('رباب')) return true;
                        }
                        return false;
                    });
                    if (matched) {
                        matchedEmployeeName = matched.name;
                        matchedEmployeeRole = matched.role;
                    }
                }

                // وقت الرسالة
                const messageTimestamp = msg.messageTimestamp 
                    ? new Date(Number(msg.messageTimestamp) * 1000) 
                    : new Date();

                // الحفظ في قاعدة البيانات
                const savedMsg = await BusinessObserverMessage.create({
                    messageId,
                    chatJid: remoteJid,
                    chatName,
                    isGroup,
                    senderPhone,
                    senderJid,
                    senderName,
                    isFromMe,
                    messageType,
                    content,
                    transcription,
                    mediaFileName,
                    mediaMimeType,
                    mediaSize,
                    mediaDuration,
                    mediaUrl,
                    matchedEmployeeName,
                    matchedEmployeeRole,
                    messageTimestamp,
                    UserId: uId
                });

                // إرسال تنبيه لحظي للواجهة بدون أي رد في الواتساب إطلاقاً (Observer Only)
                console.log(`🕵️‍♂️ [Observer Saved #${savedMsg.id}] ${isGroup ? 'Group: ' + chatName : 'Chat: ' + chatName} | From: ${senderName || senderPhone} | Type: ${messageType}`);
                if (io) {
                    io.to(`user_${uId}`).emit('observer_new_message', savedMsg);
                }
            }
        } catch (msgErr) {
            console.error('❌ [Observer] Message handling error:', msgErr);
        }
    });

    // مراقبة حدث التفاعلات المباشر (messages.reaction)
    sock.ev.on('messages.reaction', async (reactions) => {
        try {
            if (!reactions || !Array.isArray(reactions)) return;
            for (const r of reactions) {
                const targetKey = r.key;
                if (targetKey && targetKey.id) {
                    const senderJid = r.reaction?.key?.participant || (r.reaction?.key?.fromMe ? sock.user?.id : targetKey.remoteJid);
                    await handleMessageReaction(uId, io, {
                        targetMessageId: targetKey.id,
                        targetChatJid: targetKey.remoteJid,
                        emoji: r.reaction?.text || '',
                        senderJid,
                        senderName: null,
                        timestamp: r.reaction?.senderTimestampMs ? new Date(Number(r.reaction.senderTimestampMs)) : new Date()
                    });
                }
            }
        } catch (err) {
            console.error('❌ [Observer] Error handling messages.reaction event:', err);
        }
    });

    return sessionData;
}

/**
 * معالجة تفاعلات الإيموجي وتحديث حقل reactions في الرسالة المستهدفة
 */
async function handleMessageReaction(uId, io, { targetMessageId, targetChatJid, emoji, senderJid, senderName, timestamp }) {
    try {
        const message = await BusinessObserverMessage.findOne({
            where: { messageId: targetMessageId, UserId: uId }
        });
        if (!message) return;

        let reactions = message.reactions;
        if (typeof reactions === 'string') {
            try { reactions = JSON.parse(reactions); } catch (_) { reactions = []; }
        }
        if (!Array.isArray(reactions)) reactions = [];

        const senderPhone = senderJid ? senderJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '') : '';
        const cleanSenderId = senderJid ? senderJid.split('@')[0] : '';

        // إذا كان الإيموجي فارغ يعني التفاعل أزيل (Unreacted)
        if (!emoji || emoji.trim() === '') {
            reactions = reactions.filter(r => (senderPhone && r.senderPhone !== senderPhone) && (cleanSenderId && r.senderId !== cleanSenderId));
        } else {
            // مطابقة الموظف صاحب التفاعل
            let matchedName = senderName;
            const employees = await BusinessObserverEmployee.findAll({ where: { UserId: uId } });
            for (const emp of employees) {
                const cleanEmpPhone = emp.phone ? emp.phone.replace(/[^0-9]/g, '') : '';
                if (cleanEmpPhone && senderPhone && (senderPhone.endsWith(cleanEmpPhone.slice(-8)) || cleanEmpPhone.endsWith(senderPhone.slice(-8)))) {
                    matchedName = emp.name;
                    break;
                }
                if (emp.notes && (emp.notes.includes(cleanSenderId) || (senderPhone && emp.notes.includes(senderPhone)))) {
                    matchedName = emp.name;
                    break;
                }
            }

            const existingIdx = reactions.findIndex(r => 
                (senderPhone && r.senderPhone === senderPhone) || (cleanSenderId && r.senderId === cleanSenderId)
            );

            const reactionObj = {
                emoji: emoji.trim(),
                senderId: cleanSenderId,
                senderPhone,
                senderName: matchedName || senderName || senderPhone || 'مستخدم',
                timestamp: timestamp || new Date()
            };

            if (existingIdx >= 0) {
                reactions[existingIdx] = reactionObj;
            } else {
                reactions.push(reactionObj);
            }
        }

        message.reactions = reactions;
        await message.save();

        console.log(`👍 [Observer Reaction] ${emoji ? `Emoji: ${emoji}` : 'Reaction Removed'} on msg #${message.id} (${targetMessageId}) by ${senderPhone || senderJid} in ${targetChatJid}`);

        if (io) {
            io.to(`user_${uId}`).emit('observer_message_reaction', {
                messageId: targetMessageId,
                id: message.id,
                reactions
            });
        }
    } catch (err) {
        console.error('❌ [Observer] Error in handleMessageReaction:', err);
    }
}

/**
 * قطع اتصال وفصل جلسة المراقب
 */
export async function disconnectObserverSession(userId = 3, io = null) {
    const uId = parseInt(userId, 10);
    const session = observerSessions.get(uId);
    if (session && session.sock) {
        try {
            if (session.sock.ev) session.sock.ev.removeAllListeners();
            if (typeof session.sock.logout === 'function') await session.sock.logout();
            if (typeof session.sock.end === 'function') session.sock.end(undefined);
        } catch (_) {}
    }

    const authPath = path.join(process.cwd(), 'sessions', `observer_${uId}`);
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
    } catch (_) {}

    observerSessions.set(uId, {
        sock: null,
        status: 'disconnected',
        phone: null,
        name: null,
        qr: null,
        pairingCode: null
    });

    if (io) {
        io.to(`user_${uId}`).emit('observer_status', { status: 'disconnected' });
    }

    return { success: true, message: 'تم فصل جلسة المراقب الصامت بنجاح' };
}

/**
 * استعادة جلسات المراقبة النشطة تلقائياً عند إعادة تشغيل السيرفر
 */
export async function restoreObserverSessions(io = null) {
    try {
        const sessionsDir = path.join(process.cwd(), 'sessions');
        if (!fs.existsSync(sessionsDir)) return;

        const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('observer_')) {
                const uIdStr = entry.name.replace('observer_', '');
                const uId = parseInt(uIdStr, 10);
                if (uId && fs.existsSync(path.join(sessionsDir, entry.name, 'creds.json'))) {
                    console.log(`♻️ [Observer] Auto-restoring observer session for User ${uId}...`);
                    startObserverSession(uId, null, io).catch(err => {
                        console.error(`❌ [Observer] Failed to auto-restore session for User ${uId}:`, err.message);
                    });
                }
            }
        }
    } catch (e) {
        console.error('❌ [Observer] Error in restoreObserverSessions:', e);
    }
}

/**
 * جلب قائمة الجروبات من الواتساب والمحادثات المرصودة لتحديد مجالات العمل
 */
export async function getObserverWhatsAppGroups(userId = 3) {
    const uId = parseInt(userId, 10);
    const session = observerSessions.get(uId);
    const groupsMap = new Map();

    // 1. جلب الجروبات المشارك فيها حساب المراقب مباشرة من الواتساب
    if (session && session.sock && session.status === 'connected') {
        try {
            const participating = await session.sock.groupFetchAllParticipating();
            if (participating) {
                for (const [id, g] of Object.entries(participating)) {
                    groupsMap.set(id, {
                        groupJid: id,
                        groupName: g.subject || id,
                        participantsCount: g.participants?.length || 0,
                        creation: g.creation ? new Date(g.creation * 1000) : null
                    });
                }
            }
        } catch (err) {
            console.error('❌ [Observer] Error fetching participating groups from socket:', err.message);
        }
    }

    // 1.5. في حال لم نجد جروبات من سوكت المراقب، تجربة جلبها من سوكت البوت الرئيسي كـ fallback
    if (groupsMap.size === 0 && botSessions) {
        try {
            const bSession = botSessions.get(uId) || botSessions.get(3) || botSessions.get('3');
            if (bSession && bSession.user && typeof bSession.groupFetchAllParticipating === 'function') {
                const bGroups = await bSession.groupFetchAllParticipating();
                if (bGroups) {
                    for (const [id, g] of Object.entries(bGroups)) {
                        groupsMap.set(id, {
                            groupJid: id,
                            groupName: g.subject || id,
                            participantsCount: g.participants?.length || 0,
                            creation: g.creation ? new Date(g.creation * 1000) : null
                        });
                    }
                }
            }
        } catch (botErr) {
            console.error('❌ [Observer] Error fetching fallback groups from bot socket:', botErr.message);
        }
    }

    // 2. دمج الجروبات المسجلة في الرسائل المرصودة
    try {
        const recordedGroups = await BusinessObserverMessage.findAll({
            where: { UserId: uId, isGroup: true },
            attributes: ['chatJid', 'chatName'],
            group: ['chatJid', 'chatName']
        });
        for (const rg of recordedGroups) {
            if (!groupsMap.has(rg.chatJid)) {
                groupsMap.set(rg.chatJid, {
                    groupJid: rg.chatJid,
                    groupName: rg.chatName || rg.chatJid,
                    participantsCount: 0,
                    creation: null
                });
            }
        }
    } catch (_) {}

    // 3. مطابقة البيانات مع جدول التخصصات المحفوظة
    const savedGroups = await BusinessObserverGroup.findAll({ where: { UserId: uId } });
    const savedByJid = new Map();
    const savedByName = new Map();

    for (const sg of savedGroups) {
        if (sg.groupJid) savedByJid.set(sg.groupJid, sg);
        if (sg.groupName) savedByName.set(sg.groupName.trim().toLowerCase(), sg);
    }

    const result = [];
    for (const [jid, g] of groupsMap.entries()) {
        const saved = savedByJid.get(jid) || savedByName.get(g.groupName.trim().toLowerCase());
        result.push({
            groupJid: jid,
            groupName: g.groupName,
            groupDescription: saved ? saved.groupDescription : '',
            isSaved: Boolean(saved),
            savedId: saved ? saved.id : null,
            participantsCount: g.participantsCount
        });
    }

    for (const sg of savedGroups) {
        if (!result.some(r => r.savedId === sg.id || r.groupJid === sg.groupJid)) {
            result.push({
                groupJid: sg.groupJid,
                groupName: sg.groupName,
                groupDescription: sg.groupDescription,
                isSaved: true,
                savedId: sg.id,
                participantsCount: 0
            });
        }
    }

    // الترتيب: المحفوظ أولاً ثم أبجدياً
    result.sort((a, b) => (b.isSaved ? 1 : 0) - (a.isSaved ? 1 : 0) || a.groupName.localeCompare(b.groupName, 'ar'));
    return result;
}

/**
 * حفظ أو تحديث تخصص وطبيعة عمل الجروب
 */
export async function saveOrUpdateObserverGroup(userId = 3, { groupJid, groupName, groupDescription }) {
    const uId = parseInt(userId, 10);
    if (!groupName) throw new Error('اسم الجروب مطلوب');

    let group = null;
    if (groupJid) {
        group = await BusinessObserverGroup.findOne({
            where: { groupJid, UserId: uId }
        });
    }
    if (!group) {
        group = await BusinessObserverGroup.findOne({
            where: { groupName: groupName.trim(), UserId: uId }
        });
    }

    if (group) {
        group.groupDescription = (groupDescription || '').trim();
        if (groupJid && !group.groupJid) group.groupJid = groupJid;
        await group.save();
    } else {
        group = await BusinessObserverGroup.create({
            groupJid: groupJid || '',
            groupName: groupName.trim(),
            groupDescription: (groupDescription || '').trim(),
            UserId: uId
        });
    }

    return group;
}

/**
 * جلب الرسائل المرصودة مع الفلترة والتقسيم لصفحات
 */
export async function getObserverMessages(userId = 3, { page = 1, limit = 50, chatJid, senderPhone, type, search } = {}) {
    const uId = parseInt(userId, 10);
    const where = { UserId: uId };

    if (chatJid) where.chatJid = chatJid;
    if (senderPhone) where.senderPhone = { [Op.like]: `%${senderPhone}%` };
    if (type) where.messageType = type;
    if (search) {
        where[Op.or] = [
            { content: { [Op.like]: `%${search}%` } },
            { transcription: { [Op.like]: `%${search}%` } },
            { senderName: { [Op.like]: `%${search}%` } },
            { matchedEmployeeName: { [Op.like]: `%${search}%` } },
            { chatName: { [Op.like]: `%${search}%` } }
        ];
    }

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const { count, rows } = await BusinessObserverMessage.findAndCountAll({
        where,
        order: [['messageTimestamp', 'DESC']],
        limit: parseInt(limit, 10),
        offset
    });

    return {
        total: count,
        page: parseInt(page, 10),
        totalPages: Math.ceil(count / limit),
        messages: rows
    };
}

/**
 * استخراج ملخص وإحصائيات الرصد والتحليل الذكي
 */
export async function getObserverAnalytics(userId = 3) {
    const uId = parseInt(userId, 10);
    const totalMessages = await BusinessObserverMessage.count({ 
        where: { 
            UserId: uId,
            messageType: { [Op.ne]: 'other' }
        } 
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayMessages = await BusinessObserverMessage.count({
        where: {
            UserId: uId,
            messageType: { [Op.ne]: 'other' },
            messageTimestamp: { [Op.gte]: today }
        }
    });

    const voiceNotesCount = await BusinessObserverMessage.count({
        where: { UserId: uId, messageType: 'audio' }
    });

    const imagesCount = await BusinessObserverMessage.count({
        where: { UserId: uId, messageType: 'image' }
    });

    const videosCount = await BusinessObserverMessage.count({
        where: { UserId: uId, messageType: 'video' }
    });

    const employees = await BusinessObserverEmployee.findAll({ where: { UserId: uId } });
    const groups = await BusinessObserverGroup.findAll({ where: { UserId: uId } });

    return {
        totalMessages,
        todayMessages,
        voiceNotesCount,
        imagesCount,
        videosCount,
        employeesCount: employees.length,
        groupsCount: groups.length
    };
}
