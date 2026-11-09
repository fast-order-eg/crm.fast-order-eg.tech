import { CONFIG } from '../config.js';
import { GoogleAuth } from 'google-auth-library';
import { getSystemSetting } from './settingsService.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import fs from 'fs';
import path from 'path';

// ذاكرة الجلسات النشطة في الرام (groupJid -> { sessionId, history: [], lastActive: timestamp })
const sessionMemory = new Map();

// مسار تخزين جلسات أنتي جرافيتي على الجهاز
const ANTIGRAVITY_BRAIN_DIR = 'C:\\Users\\Eng Rady\\.gemini\\antigravity\\brain';
const WHATSAPP_SESSIONS_DIR = path.join(ANTIGRAVITY_BRAIN_DIR, 'whatsapp-ai-sessions');

// إنشاء مجلد جلسات الواتساب إن لم يكن موجوداً
try {
    if (!fs.existsSync(WHATSAPP_SESSIONS_DIR)) {
        fs.mkdirSync(WHATSAPP_SESSIONS_DIR, { recursive: true });
    }
} catch (e) {
    console.warn('[AI Ads Assistant] Could not create sessions dir:', e.message);
}

/**
 * فحص هل الجروب الحالي هو جروب إعلانات AI المعتمد
 */
export async function isAiAdsGroupMatch(remoteJid, rawSubject, userId = 1) {
    if (!remoteJid || !remoteJid.endsWith('@g.us')) return false;

    const enabled = await getSystemSetting('ai_ads_system_enabled', userId).catch(() => true);
    if (enabled === false) return false;

    const configuredJid = (await getSystemSetting('ai_ads_group_jid', userId).catch(() => null))
        || (await getSystemSetting('ai_ads_group_jid', 1).catch(() => null))
        || (await getSystemSetting('ai_ads_group_jid', 3).catch(() => null));

    if (configuredJid && remoteJid === configuredJid) return true;

    // مطابقة اسم الجروب التلقائية
    const subject = (rawSubject || '').toLowerCase();
    return subject.includes('إعلانات ai') ||
           subject.includes('إعلان ai') ||
           subject.includes('اعلان ai') ||
           subject.includes('اعلانات ai') ||
           subject.includes('ai ads') ||
           subject.includes('مساعد ai');
}

/**
 * فحص هل المرسل مصرح له بإعطاء الأوامر
 */
export async function isAiAdsSenderAuthorized(senderPhone, userId = 1) {
    if (!senderPhone) return false;
    const cleanPhone = String(senderPhone).replace(/[^0-9]/g, '');

    // راضي هو المسؤول الرئيسي دائماً
    if (cleanPhone.endsWith('1092308465') || cleanPhone === '01092308465' || cleanPhone === '201092308465') {
        return true;
    }

    try {
        const authorized = await getSystemSetting('ai_ads_authorized_phones', userId).catch(() => null);
        if (Array.isArray(authorized)) {
            return authorized.some(a => {
                const p = String(a.phone || a).replace(/[^0-9]/g, '');
                return cleanPhone.endsWith(p) || p.endsWith(cleanPhone);
            });
        }
    } catch (_) {}

    return false;
}

/**
 * تفريغ الفويس الصوتي باستخدام Gemini Multimodal
 */
async function transcribeVoice(audioBuffer, mimeType = 'audio/ogg') {
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
            console.error(`[Voice Transcribe] Error: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text && !p.thought) || data.candidates?.[0]?.content?.parts?.[0];
        return textPart?.text ? textPart.text.trim() : null;
    } catch (e) {
        console.error('[Voice Transcribe Failed]:', e.message);
        return null;
    }
}

/**
 * استدعاء نموذج الذكاء الاصطناعي مع الحفاظ على سياق الجلسة
 */
async function callGeminiAssistant({ prompt, imageBuffer, imageMime, history = [], systemPrompt }) {
    try {
        const url = CONFIG.getVertexUrl();

        // تحضير محتويات المحادثة مع الذاكرة السابقة
        const contents = [];

        // إضافة آخر رسائل من الجلسة السابقة
        for (const item of history.slice(-10)) {
            contents.push({
                role: item.role === 'model' ? 'model' : 'user',
                parts: [{ text: item.text }]
            });
        }

        // الرسالة الحالية
        const currentParts = [];
        if (imageBuffer) {
            currentParts.push({
                inline_data: {
                    mime_type: imageMime || 'image/jpeg',
                    data: imageBuffer.toString('base64')
                }
            });
        }
        currentParts.push({ text: prompt });

        contents.push({
            role: "user",
            parts: currentParts
        });

        const fullSystemInstruction = `${systemPrompt || ''}
- أنت تعمل كمساعد ذكي متقدم مرتبط بنظام CRM ومشروع Fast Order عبر الواتساب ومنصة Antigravity.
- تتحدث بالعامية المصرية الودودة والواضحة والمهنية.
- إذا طلب المستخدم معلومات تقنية أو إدارة حملات أو تلخيص أو كود، أجب بدقة واختصار مع أمثلة واضحة.
- تجنب الحشو والترحيب المبالغ فيه، وادخل في صلب الموضوع مباشرة.`;

        const payload = {
            contents,
            systemInstruction: {
                parts: [{ text: fullSystemInstruction }]
            },
            generationConfig: {
                temperature: 0.4,
                topP: 0.9,
                maxOutputTokens: 2048
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
            throw new Error(`Vertex AI Error ${response.status}: ${err}`);
        }

        const data = await response.json();
        const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text && !p.thought) || data.candidates?.[0]?.content?.parts?.[0];
        return textPart?.text || 'عذراً يا باشا، لم أتمكن من استخراج رد مناسب. برجاء المحاولة مرة أخرى.';
    } catch (err) {
        console.error('[Gemini Assistant Error]:', err.message);
        return `⚠️ حدث خطأ أثناء معالجة الطلب: ${err.message}`;
    }
}

/**
 * حفظ وتزامن الجلسة مع ملفات Antigravity Brain وقاعدة البيانات
 */
async function syncSessionToAntigravityAndDb({ remoteJid, userId, userText, modelReply, isVoice, hasImage, sessionId }) {
    try {
        // 1. الحفظ في قاعدة بيانات الـ CRM
        try {
            await Message.create({
                UserId: userId,
                remoteJid,
                role: 'user',
                content: userText
            });

            await Message.create({
                UserId: userId,
                remoteJid,
                role: 'assistant',
                content: modelReply
            });
        } catch (dbErr) {
            console.warn('[AI Ads Assistant] DB save warning:', dbErr.message);
        }

        // 2. الحفظ والتزامن مع ملفات جلسات Antigravity
        try {
            const dateStr = new Date().toISOString().split('T')[0];
            const sessionFileName = `session_${sessionId || dateStr}.md`;
            const sessionFilePath = path.join(WHATSAPP_SESSIONS_DIR, sessionFileName);

            const timestamp = new Date().toLocaleTimeString('ar-EG');
            const logEntry = `\n### 👤 المستخدم (${timestamp}) ${isVoice ? '🎙️ [فويس]' : ''} ${hasImage ? '📷 [صورة]' : ''}:\n${userText}\n\n### 🤖 المساعد الذكي:\n${modelReply}\n\n---\n`;

            if (!fs.existsSync(sessionFilePath)) {
                const header = `# جلسة عمل إعلانات AI ومساعد الواتساب\n**المشروع:** crm.fast-order-eg.tech\n**التاريخ:** ${dateStr}\n**معرف الجلسة:** ${sessionId}\n\n---\n`;
                fs.writeFileSync(sessionFilePath, header + logEntry, 'utf8');
            } else {
                fs.appendFileSync(sessionFilePath, logEntry, 'utf8');
            }
        } catch (fsErr) {
            console.warn('[AI Ads Assistant] Antigravity sync warning:', fsErr.message);
        }
    } catch (e) {
        console.error('[Sync Error]:', e);
    }
}

/**
 * إرسال الرسالة إلى جروب الواتساب مع محاكاة بشرية لمنع الحظر
 */
async function sendReplyToGroup(sock, remoteJid, text) {
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }

        const textLen = (text || '').length;
        const typingDuration = Math.min(6000, Math.max(2000, Math.floor(textLen * 12)));

        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            await new Promise(r => setTimeout(r, typingDuration));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }

        // إضافة invisible zero-width space لمنع تكرار الهاش
        const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
        const jitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
        const finalMessage = `${text}${jitter}`;

        await sock.sendMessage(remoteJid, { text: finalMessage });

        setTimeout(() => {
            try {
                if (typeof sock.sendPresenceUpdate === 'function') {
                    sock.sendPresenceUpdate('unavailable', remoteJid).catch(() => {});
                }
            } catch (_) {}
        }, 2000);

        return true;
    } catch (err) {
        console.error('[Send Reply Error]:', err.message);
        return false;
    }
}

/**
 * المعالج الرئيسي لرسائل جروب إعلانات AI
 */
export async function handleAiAdsAssistantMessage({
    sock,
    msg,
    remoteJid,
    phoneNumber,
    text,
    mediaBuffer,
    mediaMime,
    userId = 1,
    io
}) {
    try {
        // فحص الصلاحية
        const isAuthorized = await isAiAdsSenderAuthorized(phoneNumber, userId);
        if (!isAuthorized) {
            console.log(`🔒 [AI Ads Assistant] Unauthorized message from ${phoneNumber} in ${remoteJid}`);
            return { handled: false, reason: 'unauthorized' };
        }

        // فحص انتهاء الجلسة أو تهيئة جلسة جديدة
        const timeoutMinutes = await getSystemSetting('ai_ads_session_timeout', userId).catch(() => 360) || 360;
        const now = Date.now();

        let session = sessionMemory.get(remoteJid);
        if (!session || (now - session.lastActive > timeoutMinutes * 60 * 1000)) {
            session = {
                sessionId: `wa_${Date.now()}`,
                history: [],
                lastActive: now
            };
            sessionMemory.set(remoteJid, session);
        }
        session.lastActive = now;

        const cleanText = (text || '').trim();

        // أوامر التحكم السريع بالذاكرة
        if (cleanText === '/new' || cleanText === '/reset' || cleanText === 'جلسة جديدة' || cleanText === 'تصفير الذاكرة') {
            session.history = [];
            session.sessionId = `wa_${Date.now()}`;
            await sendReplyToGroup(sock, remoteJid, '🔄 تم تصفير سياق الذاكرة وبدء جلسة عمل جديدة ونظيفة يا باشا! جاهز لأي طلب أو أمر.');
            return { handled: true };
        }

        if (cleanText === '/status' || cleanText === 'حالة الجلسة') {
            const statusMsg = `📊 *حالة جلسة إعلانات AI:*
- 🟢 *المشروع:* crm.fast-order-eg.tech
- 💬 *الرسائل النشطة بالذاكرة:* ${session.history.length}
- 🆔 *معرف الجلسة:* ${session.sessionId}
- 👤 *المسؤول المصرح له:* ${phoneNumber}
- ⚡ *المساعد:* جاهز ومتصل بـ Antigravity و Baileys`;
            await sendReplyToGroup(sock, remoteJid, statusMsg);
            return { handled: true };
        }

        // معالجة الفويس الصوتي
        let isVoice = false;
        let promptText = cleanText;

        if (mediaBuffer && (mediaMime?.includes('audio') || mediaMime?.includes('ogg') || mediaMime?.includes('opus'))) {
            isVoice = true;
            console.log(`🎙️ [AI Ads Assistant] Transcribing voice note from ${phoneNumber}...`);
            const transcribed = await transcribeVoice(mediaBuffer, mediaMime);
            if (!transcribed) {
                await sendReplyToGroup(sock, remoteJid, 'عذراً يا باشا، لم أتمكن من سماع الصوت بوضوح، برجاء إرسال الرسالة كتابة أو إعادة تسجيلها.');
                return { handled: true };
            }
            promptText = transcribed;
            console.log(`🎙️ [AI Ads Assistant] Transcribed text: "${promptText}"`);
        }

        if (!promptText && !mediaBuffer) {
            return { handled: false };
        }

        // إرسال إشعار فوري في الجروب ببدء التفكير أو استلام الفويس
        if (isVoice) {
            await sock.sendMessage(remoteJid, { text: `🎙️ _سمعت رسالتك:_ "${promptText}"\n⏳ _جاري التحليل والتنفيذ..._` });
        }

        // جلب التوجيه الأساسي (System Prompt)
        const systemPrompt = await getSystemSetting('ai_ads_system_prompt', userId).catch(() => null);

        // استدعاء المساعد
        const hasImage = mediaBuffer && (mediaMime?.includes('image') || mediaMime?.includes('jpeg') || mediaMime?.includes('png'));
        const reply = await callGeminiAssistant({
            prompt: promptText,
            imageBuffer: hasImage ? mediaBuffer : null,
            imageMime: hasImage ? mediaMime : null,
            history: session.history,
            systemPrompt
        });

        // تحديث الذاكرة
        session.history.push({ role: 'user', text: promptText });
        session.history.push({ role: 'model', text: reply });
        if (session.history.length > 20) {
            session.history = session.history.slice(-20);
        }

        // إرسال الرد في الجروب
        await sendReplyToGroup(sock, remoteJid, reply);

        // حفظ وتزامن مع أنتي جرافيتي والداتابيز
        await syncSessionToAntigravityAndDb({
            remoteJid,
            userId,
            userText: promptText,
            modelReply: reply,
            isVoice,
            hasImage,
            sessionId: session.sessionId
        });

        return { handled: true };
    } catch (err) {
        console.error('❌ [AI Ads Assistant Error]:', err);
        return { handled: false, error: err.message };
    }
}
