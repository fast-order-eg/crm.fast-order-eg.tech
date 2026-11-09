import { CONFIG } from '../config.js';
import { GoogleAuth } from 'google-auth-library';
import { getSetting } from './settingsService.js';
import Message from '../models/Message.js';
import fs from 'fs';
import path from 'path';

// ذاكرة الجلسات النشطة في الرام (groupJid -> { sessionId, history: [], lastActive: timestamp, project: {} })
const sessionMemory = new Map();

// مسار تخزين جلسات أنتي جرافيتي على الجهاز
const ANTIGRAVITY_BRAIN_DIR = 'C:\\Users\\Eng Rady\\.gemini\\antigravity\\brain';
const WHATSAPP_SESSIONS_DIR = path.join(ANTIGRAVITY_BRAIN_DIR, 'whatsapp-ai-sessions');

try {
    if (!fs.existsSync(WHATSAPP_SESSIONS_DIR)) {
        fs.mkdirSync(WHATSAPP_SESSIONS_DIR, { recursive: true });
    }
} catch (e) {
    console.warn('[AI Ads Assistant] Could not create sessions dir:', e.message);
}

/**
 * جلب إعدادات ربط الجروبات بالمشاريع
 */
export async function getProjectsMapping(userId = 1) {
    try {
        const raw = await getSetting('ai_ads_projects_mapping', userId).catch(() => null)
            || await getSetting('ai_ads_projects_mapping', 3).catch(() => null);

        if (Array.isArray(raw) && raw.length > 0) return raw;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (_) {}

    return [
        {
            groupId: '',
            groupName: 'إعلانات AI',
            projectPath: 'crm.fast-order-eg.tech'
        }
    ];
}

/**
 * فحص هل الجروب الحالي مربوط بأحد مشاريع أنتي جرافيتي
 */
export async function isAiAdsGroupMatch(remoteJid, rawSubject, userId = 1) {
    if (!remoteJid || !remoteJid.endsWith('@g.us')) return false;

    const enabled = await getSetting('ai_ads_system_enabled', userId).catch(() => true);
    if (enabled === false) return false;

    // 1. فحص جدول الربط المتعدد للمشاريع
    const mappings = await getProjectsMapping(userId);
    const mapped = mappings.find(m => m.groupId === remoteJid);
    if (mapped) return true;

    // 2. فحص معرف الجروب المفرد
    const configuredJid = (await getSetting('ai_ads_group_jid', userId).catch(() => null))
        || (await getSetting('ai_ads_group_jid', 1).catch(() => null))
        || (await getSetting('ai_ads_group_jid', 3).catch(() => null));

    if (configuredJid && remoteJid === configuredJid) return true;

    // 3. مطابقة اسم الجروب التلقائية
    const subject = (rawSubject || '').toLowerCase();
    return subject.includes('إعلانات ai') ||
           subject.includes('إعلان ai') ||
           subject.includes('اعلان ai') ||
           subject.includes('اعلانات ai') ||
           subject.includes('ai ads') ||
           subject.includes('مساعد ai');
}

/**
 * تحديد المشروع المربوط بالجروب
 */
export async function resolveProjectForGroup(remoteJid, rawSubject, userId = 1) {
    const mappings = await getProjectsMapping(userId);
    const found = mappings.find(m => m.groupId === remoteJid);
    if (found && found.projectPath) {
        return {
            projectName: path.basename(found.projectPath),
            projectPath: found.projectPath,
            groupName: found.groupName || rawSubject || 'إعلانات AI'
        };
    }

    return {
        projectName: 'crm.fast-order-eg.tech',
        projectPath: 'e:\\programing\\flutter project\\crm.fast-order-eg.tech',
        groupName: rawSubject || 'إعلانات AI'
    };
}

/**
 * فحص هل المرسل مصرح له بإعطاء الأوامر
 */
export async function isAiAdsSenderAuthorized(senderPhone, userId = 1) {
    if (!senderPhone) return false;
    const cleanPhone = String(senderPhone).replace(/[^0-9]/g, '');

    // راضي المسؤول الأساسي دائماً (سواء من رقمه الشخصي أو رقم البوت لينا)
    if (
        cleanPhone.endsWith('1092308465') || cleanPhone === '01092308465' || cleanPhone === '201092308465' ||
        cleanPhone.endsWith('1020336379') || cleanPhone === '01020336379' || cleanPhone === '201020336379'
    ) {
        return true;
    }

    try {
        const rawAuth = await getSetting('ai_ads_authorized_phones', userId).catch(() => null);
        if (typeof rawAuth === 'string') {
            const phones = rawAuth.split(/[,;\s]+/).map(p => p.replace(/[^0-9]/g, '')).filter(Boolean);
            if (phones.some(p => cleanPhone.endsWith(p) || p.endsWith(cleanPhone))) return true;
        } else if (Array.isArray(rawAuth)) {
            return rawAuth.some(a => {
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
 * استدعاء نموذج الذكاء الاصطناعي مع الحفاظ على سياق الجلسة والمشروع
 */
async function callGeminiAssistant({ prompt, imageBuffer, imageMime, history = [], project }) {
    try {
        const url = CONFIG.getVertexUrl();

        const contents = [];
        for (const item of history.slice(-10)) {
            contents.push({
                role: item.role === 'model' ? 'model' : 'user',
                parts: [{ text: item.text }]
            });
        }

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

        const fullSystemInstruction = `أنت مساعد ذكي متقدم وخبير برمجي وإعلاني مرتبط بمشروع "${project.projectName}" ومجلد العمل "${project.projectPath}" على منصة Antigravity عبر الواتساب.
- تتحدث بالعامية المصرية الودودة والواضحة والمباشرة بدون أي حشو أو كلام إنشائي.
- أنت تنفذ الأوامر وتحلل المشاكل وتجيب على الاستفسارات الخاصة بهذا المشروع حصراً.
- إذا كان السؤال عن كود أو خطأ أو استفسار، أجب بدقة وعملية، واكتب الكود أو الحل مباشرة.
- عند الحاجة، اشرح الخطوات بأسلوب عملي ومرتب.
- هام جداً: لا ترسل أوامر التشغيل الداخلية (bash / terminal logs) أو الخطوات البرمجية الخفية في رسائل الواتساب، بل قدّم النتيجة النهائية المباشرة والإجابة الشاملة الكاملة دون أي نقص.
- ممنوع منعاً باتاً إخراج جداول الماركداون (Markdown Tables |...|...|) لأنها تظهر مكسورة ومشوهة على الموبايل في الواتساب، وبدلاً منها استخدم دائماً القوائم النقطية والترقيم الواضح والخط العريض (*عناوين*).`;

        const payload = {
            contents,
            systemInstruction: {
                parts: [{ text: fullSystemInstruction }]
            },
            generationConfig: {
                temperature: 0.3,
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
 * حفظ وتزامن الجلسة مع مجلدات Antigravity Brain وقاعدة البيانات
 */
async function syncSessionToAntigravityAndDb({ remoteJid, userId, userText, modelReply, isVoice, hasImage, sessionId, project }) {
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

        // 2. الحفظ في مجلد المشروع الخاص في Antigravity Brain
        try {
            const projectDir = path.join(WHATSAPP_SESSIONS_DIR, project.projectName.replace(/[^a-zA-Z0-9._-]/g, '_'));
            if (!fs.existsSync(projectDir)) {
                fs.mkdirSync(projectDir, { recursive: true });
            }

            const dateStr = new Date().toISOString().split('T')[0];
            const sessionFileName = `session_${sessionId || dateStr}.md`;
            const sessionFilePath = path.join(projectDir, sessionFileName);

            const timestamp = new Date().toLocaleTimeString('ar-EG');
            const logEntry = `\n### 👤 المستخدم (${timestamp}) ${isVoice ? '🎙️ [فويس]' : ''} ${hasImage ? '📷 [صورة]' : ''}:\n${userText}\n\n### 🤖 المساعد الذكي:\n${modelReply}\n\n---\n`;

            if (!fs.existsSync(sessionFilePath)) {
                const header = `# جلسة عمل واتساب لمشروع ${project.projectName}\n- **المسار:** \`${project.projectPath}\`\n- **التاريخ:** ${dateStr}\n- **معرف الجلسة:** \`${sessionId}\`\n\n---\n`;
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
 * تنظيف وتنسيق نص الرسالة ليناسب الواتساب تماماً
 * - استبدال جداول الماركداون بقوائم نقطية أنيقة قابلة للقراءة على الهاتف
 * - منع تشوه النصوص الطويلة
 */
export function formatWhatsAppMessage(rawText) {
    if (!rawText) return '';
    let text = String(rawText);

    // تحويل جداول الماركداون (| col1 | col2 |) إلى نقاط وتفاصيل مقروءة
    const tableRegex = /\|(.+)\|\r?\n\|[-:\s|]+\|\r?\n((?:\|.+\|\r?\n?)+)/g;
    text = text.replace(tableRegex, (match, headerRow, bodyRows) => {
        const headers = headerRow.split('|').map(h => h.trim()).filter(Boolean);
        const rows = bodyRows.trim().split(/\r?\n/).map(r => r.split('|').map(c => c.trim()).filter(Boolean));

        let output = '\n';
        rows.forEach(row => {
            output += '▫️ ';
            row.forEach((cell, idx) => {
                const header = headers[idx] ? `*${headers[idx]}:* ` : '';
                output += `${header}${cell} `;
            });
            output += '\n';
        });
        return output;
    });

    return text.trim();
}

/**
 * إرسال الرسالة إلى جروب الواتساب مع محاكاة بشرية لمنع الحظر
 */
async function sendReplyToGroup(sock, remoteJid, text) {
    try {
        const formatted = formatWhatsAppMessage(text);
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }

        const textLen = (formatted || '').length;
        const typingDuration = Math.min(6000, Math.max(2000, Math.floor(textLen * 12)));

        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            await new Promise(r => setTimeout(r, typingDuration));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }

        const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
        const jitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
        const finalMessage = `${formatted}${jitter}`;

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
 * المعالج الرئيسي لرسائل جروبات إعلانات ومساعد AI
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
        const isAuthorized = await isAiAdsSenderAuthorized(phoneNumber, userId);
        if (!isAuthorized) {
            console.log(`🔒 [AI Ads Assistant] Unauthorized message from ${phoneNumber} in ${remoteJid}`);
            return { handled: false, reason: 'unauthorized' };
        }

        // معرفة المشروع المربوط بهذا الجروب
        const rawSubject = (msg.pushName || '');
        const project = await resolveProjectForGroup(remoteJid, rawSubject, userId);

        const timeoutMinutes = await getSetting('ai_ads_session_timeout', userId).catch(() => 360) || 360;
        const now = Date.now();

        let session = sessionMemory.get(remoteJid);
        if (!session || (now - session.lastActive > timeoutMinutes * 60 * 1000)) {
            session = {
                sessionId: `wa_${Date.now()}`,
                history: [],
                lastActive: now,
                project
            };
            sessionMemory.set(remoteJid, session);
        }
        session.lastActive = now;
        session.project = project;

        const cleanText = (text || '').trim();

        // أوامر التحكم السريع
        if (cleanText === '/new' || cleanText === '/reset' || cleanText === 'جلسة جديدة' || cleanText === 'تصفير الذاكرة') {
            session.history = [];
            session.sessionId = `wa_${Date.now()}`;
            await sendReplyToGroup(sock, remoteJid, `🔄 تم تصفير سياق الذاكرة وبدء جلسة جديدة لمشروع *[${project.projectName}]* يا باشا! جاهز لأي طلب.`);
            return { handled: true };
        }

        if (cleanText === '/status' || cleanText === 'حالة الجلسة') {
            const statusMsg = `📊 *حالة جلسة إعلانات AI:*
- 📂 *المشروع في Antigravity:* ${project.projectName}
- 📁 *المسار:* \`${project.projectPath}\`
- 💬 *الرسائل النشطة بالذاكرة:* ${session.history.length}
- 🆔 *معرف الجلسة:* ${session.sessionId}
- 👤 *المسؤول المصرح له:* ${phoneNumber}
- ⚡ *الحالة:* متصل وجاهز لتنفيذ الأوامر`;
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
            console.log(`🎙️ [AI Ads Assistant] Transcribed: "${promptText}"`);
        }

        if (!promptText && !mediaBuffer) {
            return { handled: false };
        }

        if (isVoice) {
            await sock.sendMessage(remoteJid, { text: `🎙️ _سمعت رسالتك:_ "${promptText}"\n⏳ _جاري التحليل لمشروع [${project.projectName}]..._` });
        }

        const hasImage = mediaBuffer && (mediaMime?.includes('image') || mediaMime?.includes('jpeg') || mediaMime?.includes('png'));
        const reply = await callGeminiAssistant({
            prompt: promptText,
            imageBuffer: hasImage ? mediaBuffer : null,
            imageMime: hasImage ? mediaMime : null,
            history: session.history,
            project
        });

        session.history.push({ role: 'user', text: promptText });
        session.history.push({ role: 'model', text: reply });
        if (session.history.length > 20) {
            session.history = session.history.slice(-20);
        }

        await sendReplyToGroup(sock, remoteJid, reply);

        await syncSessionToAntigravityAndDb({
            remoteJid,
            userId,
            userText: promptText,
            modelReply: reply,
            isVoice,
            hasImage,
            sessionId: session.sessionId,
            project
        });

        return { handled: true };
    } catch (err) {
        console.error('❌ [AI Ads Assistant Error]:', err);
        return { handled: false, error: err.message };
    }
}
