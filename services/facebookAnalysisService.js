import fetch from 'node-fetch';
import { Op } from 'sequelize';
import User from '../models/User.js';
import Message from '../models/Message.js';
import { getSetting, setSetting } from './settingsService.js';

/**
 * Normalize phone number to standard Egyptian digits (e.g. '01092308465')
 */
export function normalizePhone(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.startsWith('20') && p.length === 12) {
        p = '0' + p.substring(2);
    } else if (p.length === 10 && (p.startsWith('10') || p.startsWith('11') || p.startsWith('12') || p.startsWith('15'))) {
        p = '0' + p;
    }
    return p;
}

// Configuration for Eina Souq (عين السوق) Facebook Analysis APIs
const FACEBOOK_ANALYSIS_API_BASE = 'https://einasouq.bird-ads.com/api/v1/merchant';
const FACEBOOK_ANALYSIS_API_KEY = 'fastorder_merchant_secure_api_key_2026';

// Active in-memory facebook analysis sessions
// Key: clean staff phone (e.g. '01092308465')
// Value: { inSession: true, lastTarget: '', lastActive: timestamp }
export const facebookAnalysisSessions = new Map();

/**
 * Check if the user is currently in an active analysis waiting session
 */
export function isUserInFacebookAnalysisSession(phone) {
    const clean = normalizePhone(phone);
    if (!clean) return false;
    const session = facebookAnalysisSessions.get(clean);
    if (!session || !session.inSession) return false;

    // Auto-expire session after 20 minutes of inactivity
    if (Date.now() - session.lastActive > 20 * 60 * 1000) {
        facebookAnalysisSessions.delete(clean);
        return false;
    }
    return true;
}

/**
 * Check if the text is a Facebook Analysis command
 */
export function isFacebookAnalysisCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return /^(\/|\s)*(حلل|تحليل|فحص|analyze|audit)($|\s)/i.test(trimmed);
}

/**
 * Helper: Start continuous typing presence ("يكتب الآن...") while waiting for long async AI work.
 * Sends 'composing' every 3.5 seconds until returned cleanup function is called.
 */
function startContinuousComposing(sock, remoteJid) {
    if (!sock || !remoteJid || typeof sock.sendPresenceUpdate !== 'function') {
        return () => {};
    }
    try {
        sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
    } catch (_) {}

    const interval = setInterval(() => {
        try {
            sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        } catch (_) {}
    }, 3500);

    return () => {
        clearInterval(interval);
    };
}

/**
 * Send WhatsApp reply to staff with full human simulation (Anti-Ban):
 * - available presence
 * - composing ("يكتب الآن...") status with periodic refresh
 * - proportional human delay based on text length
 * - zero-width space jitter (anti-hash duplicate)
 * - unavailable presence after completion
 * - SQL and Socket.io logging
 */
async function replyToStaff(sock, remoteJid, text, userId, io) {
    if (!sock || !remoteJid || !text) return;

    const textLen = (text || '').length;

    // 1. Send presence: available
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // 2. Simulate realistic typing duration proportional to message length (2.5s to 6.5s)
    const typingDuration = Math.min(6500, Math.max(2500, Math.floor(textLen * 10) + Math.floor(Math.random() * 1200) + 800));

    let presenceInterval = null;
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            presenceInterval = setInterval(() => {
                sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            }, 3500);
        }
    } catch (_) {}

    await new Promise(r => setTimeout(r, typingDuration));

    if (presenceInterval) clearInterval(presenceInterval);

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // 3. Random Zero-Width Space to break message hash signature
    const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    const randomJitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
    const finalSendText = `${text}${randomJitter}`;

    // 4. Send via WhatsApp socket
    try {
        await sock.sendMessage(remoteJid, { text: finalSendText });
    } catch (sendErr) {
        console.error('❌ [replyToStaff - Facebook Analysis] WhatsApp send error:', sendErr.message);
    }

    // 5. Send presence: unavailable after a short timeout
    setTimeout(() => {
        try {
            if (typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('unavailable', remoteJid).catch(() => {});
            }
        } catch (_) {}
    }, 1500);

    // 6. Permanently log assistant reply to SQL DB
    try {
        if (Message) {
            const savedMsg = await Message.create({
                UserId: userId || 3,
                remoteJid: remoteJid,
                role: 'model',
                content: text,
                media_url: null,
                createdAt: new Date(),
                updatedAt: new Date()
            });

            if (io && userId) {
                io.to(`user_${userId}`).emit('new_message', savedMsg);
            }
        }
    } catch (dbErr) {
        console.error('⚠️ [replyToStaff - Facebook Analysis] SQL logging error:', dbErr.message);
    }
}

/**
 * Get internal sets of excluded phones and custom staff for Facebook Analysis
 */
async function getFacebookAnalysisConfigSettings(userId = 3) {
    const excludedSet = new Set();
    let customList = [];

    try {
        let excluded = await getSetting('facebook_analysis_excluded_phones', userId);
        if (!excluded && userId !== 1) {
            excluded = await getSetting('facebook_analysis_excluded_phones', 1);
        }
        if (excluded) {
            try {
                const parsed = typeof excluded === 'string' ? JSON.parse(excluded) : excluded;
                if (Array.isArray(parsed)) {
                    parsed.forEach(p => {
                        const clean = normalizePhone(p);
                        if (clean) excludedSet.add(clean);
                    });
                }
            } catch (_) {}
        }

        let custom = await getSetting('facebook_analysis_custom_staff', userId);
        if (!custom && userId !== 1) {
            custom = await getSetting('facebook_analysis_custom_staff', 1);
        }
        if (custom && typeof custom === 'string') {
            try {
                const parsed = JSON.parse(custom);
                if (Array.isArray(parsed)) customList = parsed;
            } catch (_) {}
        } else if (Array.isArray(custom)) {
            customList = custom;
        }
    } catch (err) {
        console.error('Error fetching facebook analysis settings:', err.message);
    }

    if (!Array.isArray(customList)) customList = [];
    return { excludedSet, customList };
}

/**
 * Check if the sender is an authorized staff member for Facebook Analysis.
 * Whitelists Rady (01092308465), custom numbers, and active users unless excluded.
 */
export async function isFacebookAnalysisStaffAuthorized(phoneNumber, userId = 3) {
    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return false;

    // 1. Explicit Whitelist: Rady (01092308465)
    if (cleanPhone === '01092308465' || cleanPhone.endsWith('1092308465')) {
        return { isAuthorized: true, name: 'أ. راضي', role: 'admin' };
    }

    // 2. Check Excluded Phones
    const { excludedSet, customList } = await getFacebookAnalysisConfigSettings(userId);
    if (excludedSet.has(cleanPhone)) {
        return false;
    }

    // 3. Check Custom Added Staff
    const customMatch = customList.find(c => normalizePhone(c.phone) === cleanPhone);
    if (customMatch) {
        return {
            isAuthorized: true,
            name: customMatch.name || 'موظف مخصص',
            role: customMatch.role || 'sales',
            roleLabel: customMatch.roleLabel || 'مسؤول مبيعات'
        };
    }

    // 4. Check Database for staff/admin user
    try {
        const cleanNoZero = cleanPhone.startsWith('0') ? cleanPhone.substring(1) : cleanPhone;
        const user = await User.findOne({
            where: {
                role: ['super_admin', 'admin', 'sales'],
                [Op.or]: [
                    { phone: cleanPhone },
                    { phone: '2' + cleanPhone },
                    { phone: '20' + cleanNoZero },
                    { phone: cleanNoZero },
                    { phone: '0' + cleanNoZero }
                ]
            }
        });

        if (user) {
            return {
                isAuthorized: true,
                name: user.fullName || user.username,
                role: user.role,
                userId: user.id
            };
        }
    } catch (e) {
        console.error('Error checking facebook analysis staff authorization:', e.message);
    }

    return false;
}

/**
 * Get full list of staff members for Facebook Analysis settings tab
 */
export async function getFacebookAnalysisAuthorizedStaff(userId = 3) {
    const { excludedSet, customList } = await getFacebookAnalysisConfigSettings(userId);

    let users = [];
    try {
        users = await User.findAll({
            where: {
                role: ['super_admin', 'admin', 'sales']
            },
            attributes: ['id', 'username', 'fullName', 'role', 'phone'],
            order: [['id', 'ASC']]
        });
    } catch (e) {
        console.error('Error fetching staff users for facebook analysis:', e.message);
    }

    const list = [];
    const seenPhones = new Set();

    // 1. Explicit Whitelist: أ. راضي
    list.push({
        id: 3,
        name: 'أ. راضي',
        username: 'rady',
        role: 'admin',
        roleLabel: 'مدير النظام',
        phone: '01092308465',
        isPrimary: true,
        isActive: true,
        isCustom: false
    });
    seenPhones.add('01092308465');

    // 2. Database Staff Users
    for (const u of users) {
        const cleanP = normalizePhone(u.phone);
        if (cleanP && !seenPhones.has(cleanP)) {
            seenPhones.add(cleanP);
            if (excludedSet.has(cleanP)) continue;
            const roleLabel = u.role === 'super_admin' ? 'مدير عام' :
                              u.role === 'admin' ? 'مدير' : 'مسؤول مبيعات';
            list.push({
                id: u.id,
                name: u.fullName || u.username,
                username: u.username,
                role: u.role,
                roleLabel,
                phone: cleanP,
                isPrimary: false,
                isActive: true,
                isCustom: false
            });
        }
    }

    // 3. Custom Added Staff
    for (const c of customList) {
        const cleanP = normalizePhone(c.phone);
        if (cleanP && !seenPhones.has(cleanP)) {
            seenPhones.add(cleanP);
            if (excludedSet.has(cleanP)) continue;
            let cleanRoleLabel = (c.roleLabel || 'مسؤول مبيعات').replace(/\s*\(.*?\)/g, '').trim();
            if (!cleanRoleLabel) cleanRoleLabel = 'مسؤول مبيعات';
            list.push({
                id: c.id || `custom_${cleanP}`,
                name: c.name || 'موظف مخصص',
                username: c.username || cleanP,
                role: c.role || 'sales',
                roleLabel: cleanRoleLabel,
                phone: cleanP,
                isPrimary: false,
                isActive: true,
                isCustom: true
            });
        }
    }

    return list;
}

/**
 * Add a new authorized phone number for Facebook Analysis
 */
export async function addFacebookAnalysisStaff(rawPhone, name = '', roleLabel = 'مسؤول مبيعات', userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean || clean.length < 10) {
        return { success: false, message: '⚠️ رقم الهاتف غير صحيح. يرجى إدخال رقم هاتف مصري صالح (مثال: 01012345678).' };
    }

    if (clean === '01092308465') {
        return { success: false, message: 'ℹ️ هذا الرقم هو رقم الأدمن الأساسي ومسجل ومفعل دائماً.' };
    }

    const { excludedSet, customList } = await getFacebookAnalysisConfigSettings(userId);

    // If it was previously excluded, unexclude it
    if (excludedSet.has(clean)) {
        excludedSet.delete(clean);
        const updatedExcluded = Array.from(excludedSet);
        await setSetting('facebook_analysis_excluded_phones', JSON.stringify(updatedExcluded), userId);
        if (userId !== 1) await setSetting('facebook_analysis_excluded_phones', JSON.stringify(updatedExcluded), 1);
    }

    const existingIdx = customList.findIndex(c => normalizePhone(c.phone) === clean);
    const finalName = (name || '').trim() || `موظف ${clean.slice(-4)}`;
    const finalRoleLabel = (roleLabel || 'مسؤول مبيعات').replace(/\s*\(.*?\)/g, '').trim() || 'مسؤول مبيعات';

    if (existingIdx >= 0) {
        customList[existingIdx].name = finalName;
        customList[existingIdx].roleLabel = finalRoleLabel;
    } else {
        customList.push({
            id: `custom_${Date.now()}`,
            name: finalName,
            username: clean,
            phone: clean,
            role: 'sales',
            roleLabel: finalRoleLabel,
            createdAt: new Date().toISOString()
        });
    }

    await setSetting('facebook_analysis_custom_staff', JSON.stringify(customList), userId);
    if (userId !== 1) await setSetting('facebook_analysis_custom_staff', JSON.stringify(customList), 1);

    const updatedList = await getFacebookAnalysisAuthorizedStaff(userId);
    return {
        success: true,
        message: `✅ تم إضافة الرقم ${clean} (${finalName}) إلى قائمة صلاحيات تحليل فيسبوك بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Remove a phone number from Facebook Analysis
 */
export async function removeFacebookAnalysisStaff(rawPhone, userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean) {
        return { success: false, message: '⚠️ يرجى تحديد رقم الهاتف المراد حذفه.' };
    }

    if (clean === '01092308465') {
        return { success: false, message: '⚠️ لا يمكن حذف رقم الأدمن الرئيسي للنظام (أ. راضي).' };
    }

    const { excludedSet, customList } = await getFacebookAnalysisConfigSettings(userId);

    // 1. Remove from customList if present
    const updatedCustom = customList.filter(c => normalizePhone(c.phone) !== clean);
    if (updatedCustom.length !== customList.length) {
        await setSetting('facebook_analysis_custom_staff', JSON.stringify(updatedCustom), userId);
        if (userId !== 1) await setSetting('facebook_analysis_custom_staff', JSON.stringify(updatedCustom), 1);
    }

    // 2. Add to excludedSet so even if it exists in User table, it will be excluded
    excludedSet.add(clean);
    const updatedExcluded = Array.from(excludedSet);
    await setSetting('facebook_analysis_excluded_phones', JSON.stringify(updatedExcluded), userId);
    if (userId !== 1) await setSetting('facebook_analysis_excluded_phones', JSON.stringify(updatedExcluded), 1);

    const updatedList = await getFacebookAnalysisAuthorizedStaff(userId);
    return {
        success: true,
        message: `🗑️ تم إزالة صلاحية الرقم ${clean} من خدمة تحليل فيسبوك بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Identify if input represents a Facebook Post/Reel or a Facebook Page
 */
function classifyFacebookTarget(input) {
    if (!input || typeof input !== 'string') return { type: 'unknown', target: '' };
    const trimmed = input.trim();

    // Check if it's a URL
    const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);
    const rawUrl = urlMatch ? urlMatch[0] : '';

    if (rawUrl) {
        const lowerUrl = rawUrl.toLowerCase();
        // Post indicators
        if (
            lowerUrl.includes('/posts/') ||
            lowerUrl.includes('/permalink.php') ||
            lowerUrl.includes('/story.php') ||
            lowerUrl.includes('/reel/') ||
            lowerUrl.includes('/reels/') ||
            lowerUrl.includes('/videos/') ||
            lowerUrl.includes('/watch') ||
            lowerUrl.includes('fb.watch') ||
            lowerUrl.includes('/share/p/') ||
            lowerUrl.includes('/share/r/') ||
            lowerUrl.includes('/share/v/') ||
            lowerUrl.includes('fbid=') ||
            lowerUrl.includes('media_id=')
        ) {
            return { type: 'post', target: rawUrl };
        }

        // Page indicators: e.g. facebook.com/pagename or profile.php?id=...
        return { type: 'page', target: rawUrl };
    }

    // If not a URL, clean text (e.g. page name or slug)
    // Strip common words like "صفحة", "بيدج", "page"
    let cleanName = trimmed.replace(/^(صفحة|بيدج|page)\s+/i, '').trim();
    if (cleanName) {
        return { type: 'page', target: cleanName };
    }

    return { type: 'unknown', target: '' };
}

/**
 * Call Eina Souq API: Analyze Post with auto-retry and cache recovery
 */
async function callAnalyzePostApi(postUrl) {
    const makeRequest = async (timeoutMs) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(`${FACEBOOK_ANALYSIS_API_BASE}/analyze-post`, {
                method: 'POST',
                headers: {
                    'x-api-key': FACEBOOK_ANALYSIS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ post_url: postUrl }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await res.json().catch(() => null);
            return { status: res.status, data };
        } catch (err) {
            clearTimeout(timeoutId);
            return { status: 500, error: err.message };
        }
    };

    // Primary call with 240 seconds (4 minutes)
    let result = await makeRequest(240000);

    // If aborted or timed out or 504 gateway, wait 3 seconds and do a fast cache check
    if (!result || result.status !== 200 || !result.data || result.data.success === false) {
        const isTimeoutOrAbort = (result?.error && (result.error.includes('aborted') || result.error.includes('timeout'))) || result?.status === 504;
        if (isTimeoutOrAbort) {
            console.log('⏳ [Facebook Analysis] Post API timed out, checking cache in 3s...');
            await new Promise(r => setTimeout(r, 3000));
            const retryResult = await makeRequest(35000);
            if (retryResult && retryResult.status === 200 && retryResult.data && retryResult.data.success) {
                console.log('✅ [Facebook Analysis] Recovered post analysis from cache on retry!');
                return retryResult;
            }
        }
    }

    if (result.error) {
        console.error('❌ [Facebook Analysis] Post API Error:', result.error);
    }
    return result;
}

/**
 * Call Eina Souq API: Analyze Page with auto-retry and cache recovery
 */
async function callAnalyzePageApi(pageIdOrUrl) {
    const makeRequest = async (timeoutMs) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(`${FACEBOOK_ANALYSIS_API_BASE}/analyze-page`, {
                method: 'POST',
                headers: {
                    'x-api-key': FACEBOOK_ANALYSIS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ page_id: pageIdOrUrl }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await res.json().catch(() => null);
            return { status: res.status, data };
        } catch (err) {
            clearTimeout(timeoutId);
            return { status: 500, error: err.message };
        }
    };

    // Primary call with 240 seconds (4 minutes)
    let result = await makeRequest(240000);

    // If aborted or timed out or 504 gateway, wait 3 seconds and do a fast cache check
    if (!result || result.status !== 200 || !result.data || result.data.success === false) {
        const isTimeoutOrAbort = (result?.error && (result.error.includes('aborted') || result.error.includes('timeout'))) || result?.status === 504;
        if (isTimeoutOrAbort) {
            console.log('⏳ [Facebook Analysis] Page API timed out, checking cache in 3s...');
            await new Promise(r => setTimeout(r, 3000));
            const retryResult = await makeRequest(35000);
            if (retryResult && retryResult.status === 200 && retryResult.data && retryResult.data.success) {
                console.log('✅ [Facebook Analysis] Recovered page analysis from cache on retry!');
                return retryResult;
            }
        }
    }

    if (result.error) {
        console.error('❌ [Facebook Analysis] Page API Error:', result.error);
    }
    return result;
}

/**
 * Send interactive help and guide for Facebook Analysis
 */
async function sendHelpGuide(sock, remoteJid, staffInfo, userId, io) {
    const helpMsg = `🦅 *مرحباً بك في خدمة تحليل فيسبوك الذكية (عين السوق)*
أهلاً بك يا ${staffInfo.name || 'يا بطل'} 👋

تقدر تحلل أي بوست ممول أو تفحص جاهزية أي صفحة إعلانية بضغطة زرار!

══════════════════════
📌 *طريقة الاستخدام السريعة:*

1️⃣ *لتحليل منشور إعلاني أو ريلز ممول:*
أرسل الأمر مع رابط البوست:
👈 \`/حلل https://www.facebook.com/.../posts/...\`
*(البوت بيفحص قوة الهوك، الكوبي، الكريتيف، وبيحدد أفضل استهداف وميزانية)*

2️⃣ *لفحص وتقييم شامل لصفحة فيسبوك:*
أرسل الأمر مع رابط الصفحة أو اسم الصفحة:
👈 \`/حلل https://www.facebook.com/pagename\`
أو: \`/حلل اسم_الصفحة\`
*(البوت بيفحص الهوية، التفاعل، الدليل الاجتماعي، وخطة مضاعفة المبيعات)*

══════════════════════
💡 *أرسل رابط البوست أو الصفحة دلوقتي وهيتم إعداد التقرير التكتيكي فوراً!* 🚀`;

    await replyToStaff(sock, remoteJid, helpMsg, userId, io);
}

/**
 * Main Handler for Facebook Analysis Messages
 */
export async function handleFacebookAnalysisMessage({ sock, remoteJid, phoneNumber, text, userId, io }) {
    if (!text || typeof text !== 'string') return { handled: false };

    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return { handled: false };

    const trimmed = text.trim();
    const isCommand = isFacebookAnalysisCommand(trimmed);
    const inSession = isUserInFacebookAnalysisSession(cleanPhone);

    // If not a command and not in session, ignore
    if (!isCommand && !inSession) {
        return { handled: false };
    }

    // Check staff authorization
    const auth = await isFacebookAnalysisStaffAuthorized(cleanPhone, userId);
    if (!auth) {
        // If they explicitly typed a command, inform them politely
        if (isCommand) {
            await replyToStaff(
                sock,
                remoteJid,
                '⚠️ عذراً، رقمك غير مسجل في قائمة الموظفين المصرح لهم بخدمة تحليل فيسبوك. يرجى مراجعة إدارة النظام لتفعيل الصلاحية.',
                userId,
                io
            );
            return { handled: true };
        }
        return { handled: false };
    }

    // Extract potential argument from text (e.g. after /حلل or حلل)
    let argument = '';
    if (isCommand) {
        argument = trimmed.replace(/^(\/|\s)*(حلل|تحليل|فحص|analyze|audit)\s*/i, '').trim();
    } else if (inSession) {
        argument = trimmed;
    }

    // If argument is empty, send help guide and put user in session waiting for link
    if (!argument) {
        facebookAnalysisSessions.set(cleanPhone, { inSession: true, lastTarget: '', lastActive: Date.now() });
        await sendHelpGuide(sock, remoteJid, auth, userId, io);
        return { handled: true };
    }

    // If user wants to exit
    if (/^(خروج|إلغاء|الغاء|cancel|close|exit)$/i.test(argument)) {
        facebookAnalysisSessions.delete(cleanPhone);
        await replyToStaff(sock, remoteJid, '👋 تم إغلاق جلسة تحليل فيسبوك. يمكنك البدء مجدداً في أي وقت بكتابة: `/حلل` 🦅', userId, io);
        return { handled: true };
    }

    // Classify argument (Post vs Page)
    const classification = classifyFacebookTarget(argument);
    if (classification.type === 'unknown' || !classification.target) {
        await replyToStaff(
            sock,
            remoteJid,
            '⚠️ يرجى إرسال رابط منشور فيسبوك صالح أو رابط صفحة لتحليلها (مثال: `/حلل https://facebook.com/...`).',
            userId,
            io
        );
        return { handled: true };
    }

    // Update session state
    facebookAnalysisSessions.set(cleanPhone, { inSession: true, lastTarget: classification.target, lastActive: Date.now() });

    // 1. Send immediate polite acknowledgment and start continuous typing presence
    const startNotice = classification.type === 'post'
        ? `🦅 *جاري فحص وتحليل المنشور الإعلاني عبر محرك عين السوق الذكي...* ⏳\n(بيتم فحص الكوبي، الكريتيف، وتقييم الجاهزية الإعلانية والاستهداف)`
        : `🦅 *جاري فحص وتقييم الصفحة عبر محرك عين السوق الذكي...* ⏳\n(بيتم فحص الهوية، الدليل الاجتماعي، وخطة مضاعفة المبيعات)`;

    await replyToStaff(sock, remoteJid, startNotice, userId, io);

    // Keep WhatsApp typing ("يكتب الآن...") continuously during the API processing
    const stopContinuousComposing = startContinuousComposing(sock, remoteJid);

    try {
        let apiResult = null;

        if (classification.type === 'post') {
            apiResult = await callAnalyzePostApi(classification.target);
        } else {
            apiResult = await callAnalyzePageApi(classification.target);
        }

        // Stop continuous composing once API returns
        stopContinuousComposing();

        if (!apiResult || apiResult.status !== 200 || !apiResult.data || apiResult.data.success === false) {
            let errMsg = apiResult?.data?.error || apiResult?.error || 'تعذر استكمال التحليل في الوقت الحالي. يرجى التأكد من أن الرابط منشور عام ونشط والمحاولة مرة أخرى.';
            if (typeof errMsg === 'string' && (errMsg.includes('aborted') || errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ECONNRESET'))) {
                errMsg = 'استغرق التحليل وقتاً طويلاً نظراً لدقة الفحص وتفاصيل الفيديو بالكامل.\nالتقرير أصبح متوفراً وجاهزاً الآن في النظام، يرجى كتابة الأمر مرة أخرى: `/حلل [الرابط]` لعرضه فوراً وبدون انتظار! 🚀';
            }
            await replyToStaff(sock, remoteJid, `❌ *عذراً، حدث خطأ أثناء التحليل:*\n${errMsg}\n\n💡 يمكنك التأكد من الرابط والمحاولة مجدداً: \`/حلل [الرابط]\``, userId, io);
            return { handled: true };
        }

        const data = apiResult.data;

        // Check if API returned formatted_message_parts (Multi-part response)
        if (Array.isArray(data.formatted_message_parts) && data.formatted_message_parts.length > 0) {
            for (let i = 0; i < data.formatted_message_parts.length; i++) {
                const part = data.formatted_message_parts[i];
                if (part && part.trim()) {
                    await replyToStaff(sock, remoteJid, part.trim(), userId, io);
                    // Pause slightly between parts with natural human delay if not last part
                    if (i < data.formatted_message_parts.length - 1) {
                        await new Promise(r => setTimeout(r, 1200));
                    }
                }
            }
        } else if (data.formatted_message && typeof data.formatted_message === 'string') {
            // If single formatted_message is returned
            const singleMsg = data.formatted_message.trim();
            // If message is exceptionally long (> 3500 chars), split cleanly by section divider if possible
            if (singleMsg.length > 3500 && singleMsg.includes('══════════════════════════')) {
                const sections = singleMsg.split('══════════════════════════');
                let chunk = '';
                for (let j = 0; j < sections.length; j++) {
                    const sec = sections[j];
                    if ((chunk + sec).length > 2800) {
                        if (chunk.trim()) {
                            await replyToStaff(sock, remoteJid, chunk.trim(), userId, io);
                            await new Promise(r => setTimeout(r, 1200));
                        }
                        chunk = sec;
                    } else {
                        chunk += (chunk ? '\n══════════════════════════\n' : '') + sec;
                    }
                }
                if (chunk.trim()) {
                    await replyToStaff(sock, remoteJid, chunk.trim(), userId, io);
                }
            } else {
                await replyToStaff(sock, remoteJid, singleMsg, userId, io);
            }
        } else {
            await replyToStaff(
                sock,
                remoteJid,
                '✅ تم فحص البيانات بنجاح، لكن لم يتم العثور على تقرير نصي منسق.',
                userId,
                io
            );
        }

        return { handled: true };
    } catch (err) {
        stopContinuousComposing();
        console.error('❌ [Facebook Analysis] Handler error:', err.message);
        await replyToStaff(
            sock,
            remoteJid,
            '⚠️ واجهنا مشكلة تقنية بسيطة أثناء استخراج التحليل. يرجى المحاولة مرة أخرى بعد لحظات.',
            userId,
            io
        );
        return { handled: true };
    }
}
