import fetch from 'node-fetch';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { Op } from 'sequelize';
import { getSetting, setSetting } from './settingsService.js';
import { cleanAnalysisText } from './facebookAnalysisService.js';
import { getAdsAuthorizedAdmins } from './adsReportService.js';
import { isFacebookAnalysisStaffAuthorized } from './facebookAnalysisService.js';

const CAMPAIGN_TARGETING_API_URL = 'https://einasouq.bird-ads.com/api/v1/merchant/campaign-targeting';
const CAMPAIGN_TARGETING_API_KEY = 'fastorder_merchant_secure_api_key_2026';

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

/**
 * Active campaign targeting sessions in memory (chatId -> { campaignId, updatedAt })
 */
export const campaignTargetingSessions = new Map();

export function getActiveCampaignTargetingSession(remoteJid) {
    if (!remoteJid) return null;
    const session = campaignTargetingSessions.get(remoteJid);
    if (!session) return null;
    // 60 minutes validity
    if (Date.now() - session.updatedAt > 60 * 60 * 1000) {
        campaignTargetingSessions.delete(remoteJid);
        return null;
    }
    return session;
}

/**
 * Check if the text is a plain "استهداف" prompt without ID (to show help/usage)
 */
export function isPlainTargetingCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return /^[\/\s]*(استهداف|targeting)[\/\s]*$/i.test(trimmed);
}

/**
 * Check if text is a follow-up targeting command (e.g. "استهداف بديل", "استهداف اخر", "بديل", "استهداف ...")
 */
export function isFollowupTargetingCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return /^(?:btn_alternative_targeting|🎯\s*استهداف\s*بديل|استهداف\s*(?:بديل|اخر|آخر|تاني|تانى|جديد)|بديل|زاوية\s*(?:تانية|تاني|تانى|بديلة)|استهداف\s+[^\d]+|عايز\s+استهداف|هات\s+استهداف)/i.test(trimmed);
}

/**
 * Check if text contains a campaign targeting audit command
 */
export function isCampaignTargetingCommand(text, remoteJid = null) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();

    // 1. Must contain a campaign ID (between 6 and 20 digits) + targeting keyword
    const targetingKeyword = '(?:استهداف|فحص\\s*استهداف|تقييم\\s*استهداف|audit\\s*targeting|targeting)';
    const hasTargetingWord = new RegExp(`(?:^|[\\/\\s])${targetingKeyword}(?:[\\s\\d_]|$)`, 'i').test(trimmed);
    const hasDigits = /\d{6,20}/.test(trimmed);

    if (hasDigits && (hasTargetingWord || /(?:حملة|camp)/i.test(trimmed))) {
        return true;
    }

    // 2. Or is a follow-up targeting command
    if (isFollowupTargetingCommand(trimmed)) {
        return true;
    }

    return false;
}

/**
 * Extract Campaign ID from command text or session
 */
export function extractCampaignTargetingId(text, remoteJid = null) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();

    // 1. Prefix: "استهداف 120251570884260531" or "/استهداف 120251570884260531"
    const prefixMatch = trimmed.match(/(?:^|[\/\s])(?:استهداف|فحص\s*استهداف|تقييم\s*استهداف|targeting)\s*[:=\-]?\s*(\d{6,20})/i);
    if (prefixMatch && prefixMatch[1]) return prefixMatch[1];

    // 2. Suffix: "120251570884260531 استهداف"
    const suffixMatch = trimmed.match(/(\d{6,20})\s*(?:استهداف|targeting)/i);
    if (suffixMatch && suffixMatch[1]) return suffixMatch[1];

    // 3. Any 6-20 digit number in string containing targeting keyword
    if (/(?:استهداف|targeting)/i.test(trimmed)) {
        const anyDigits = trimmed.match(/(\d{6,20})/);
        if (anyDigits && anyDigits[1]) return anyDigits[1];
    }

    // 4. Fallback to active chat session
    if (remoteJid) {
        const session = getActiveCampaignTargetingSession(remoteJid);
        if (session && session.campaignId) {
            return session.campaignId;
        }
    }

    return null;
}

/**
 * Start continuous typing presence while long AI analysis runs
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
 * Format and refine targeting message text according to user preferences:
 * 1. Clean header to direct "🎯 *مقترحات الاستهداف:*"
 * 2. Remove fake user directive line if it was just "/استهداف" or empty
 * 3. Split behaviors so each is on its own bullet line
 * 4. Remove AdSet name/post repetition if single AdSet
 */
export function formatTargetingReportPart(text, adsetsCount = 1) {
    if (!text || typeof text !== 'string') return text;
    let t = text;

    // 1. Remove fake user directive if it only contains command keywords
    t = t.replace(/\n?📝\s*\*بناءً على طلبك وملاحظاتك:\*\s*["'/]?(?:استهداف|\/استهداف|targeting)["'/]?\s*\n?/gi, '\n');

    // 2. Simplify header in Part 2: start directly with "مقترحات الاستهداف"
    t = t.replace(/🚀\s*\*مقترحات الاستهداف البديل المخصص للمجموعة\*\s*🎯/gi, '🎯 *مقترحات الاستهداف:*');
    t = t.replace(/🚀\s*\*مقترحات الاستهداف.*?\*\s*🎯/gi, '🎯 *مقترحات الاستهداف:*');

    // 3. If single AdSet, remove repeated Group/AdSet name and redundant brackets
    if (adsetsCount <= 1) {
        t = t.replace(/\n?📂\s*\*المجموعة:\*\s*[^\n]+\n?/gi, '\n');
        t = t.replace(/\n?\(مختارة حصرياً من قاموس ميتا الرسمي المعتمد\)\n?/gi, '\n');
    }

    // 4. Split behaviors so each behavior is on its own bullet line:
    // e.g. "• *السلوكيات المقترحة:* [Retail page admins] مع [Business page admins] وسلوك [Small Business Owners]"
    t = t.replace(/•\s*\*السلوكيات المقترحة:\*\s*([^\n]+)/gi, (match, content) => {
        const bracketItems = content.match(/\[[^\]]+\]/g);
        if (bracketItems && bracketItems.length > 0) {
            return `• *السلوكيات المقترحة:*\n` + bracketItems.map(item => `  ▫️ ${item}`).join('\n');
        }
        return match;
    });

    // 5. Split current interests/behaviors if joined on a single comma/dash line in Part 1
    t = t.replace(/•\s*\*الاهتمامات الحالية:\*\s*([^\n]+)/gi, (match, content) => {
        const bracketItems = content.match(/\[[^\]]+\](?:\s*[✅❌])?/g);
        if (bracketItems && bracketItems.length > 1) {
            return `• *الاهتمامات الحالية:*\n` + bracketItems.map(item => `  ▫️ ${item}`).join('\n');
        }
        return match;
    });

    // 6. Clean extra empty lines
    t = t.replace(/\n{3,}/g, '\n\n');

    return t.trim();
}

/**
 * Send reply with human simulation, anti-ban jitter, and DB logging
 */
async function replyToTargetingChat(sock, remoteJid, text, userId = 3, io = null, isGroup = false) {
    if (!sock || !remoteJid || !text) return;

    const textLen = (text || '').length;

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // Human typing simulation (2.5s - 5.5s)
    const typingDuration = Math.min(5500, Math.max(2500, Math.floor(textLen * 8) + Math.floor(Math.random() * 1000) + 500));

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            await new Promise(r => setTimeout(r, typingDuration));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // Zero-width space jitter to break message hash
    const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    const randomJitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
    const finalSendText = `${text}${randomJitter}`;

    try {
        await sock.sendMessage(remoteJid, { text: finalSendText });
    } catch (sendErr) {
        console.error('❌ [Campaign Targeting] WhatsApp send error:', sendErr.message);
    }

    setTimeout(() => {
        try {
            if (typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('unavailable', remoteJid).catch(() => {});
            }
        } catch (_) {}
    }, 1500);

    // Save to DB and emit to socket if private chat
    if (!isGroup) {
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
            console.error('⚠️ [Campaign Targeting] DB logging error:', dbErr.message);
        }
    }
}

/**
 * Call the Campaign Targeting API on einasouq
 */
export async function callCampaignTargetingApi(rawText, campaignId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 180 seconds

    try {
        console.log(`📡 [Campaign Targeting API] Calling endpoint with text: "${rawText}" (campaign_id: ${campaignId})...`);
        const payload = {
            text: String(rawText || '').trim()
        };
        if (campaignId) {
            payload.campaign_id = String(campaignId).trim();
        }

        const response = await fetch(CAMPAIGN_TARGETING_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CAMPAIGN_TARGETING_API_KEY
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            let parsedErr = errText;
            try {
                const parsed = JSON.parse(errText);
                parsedErr = parsed.error || parsed.message || errText;
            } catch (_) {}
            return {
                success: false,
                error: parsedErr || `HTTP error ${response.status}`
            };
        }

        const data = await response.json();
        return data;
    } catch (err) {
        clearTimeout(timeout);
        console.error(`❌ [Campaign Targeting API Error]:`, err.message);
        return {
            success: false,
            error: err.name === 'AbortError' ? 'استغرق الفحص وقتاً طويلاً وتجاوز مهلة الانتظار (Timeout).' : err.message
        };
    }
}

/**
 * Get targeting configuration settings (excluded phones & custom staff)
 */
export async function getTargetingConfigSettings(userId = 3) {
    let excludedSet = new Set();
    let customList = [];

    try {
        let excluded = await getSetting('targeting_excluded_phones', userId);
        if (!excluded && userId !== 3) excluded = await getSetting('targeting_excluded_phones', 3);
        if (!excluded && userId !== 1) excluded = await getSetting('targeting_excluded_phones', 1);

        if (typeof excluded === 'string' && excluded.trim()) {
            try {
                const parsed = JSON.parse(excluded);
                if (Array.isArray(parsed)) excludedSet = new Set(parsed.map(p => normalizePhone(p)).filter(Boolean));
            } catch (_) {}
        } else if (Array.isArray(excluded)) {
            excludedSet = new Set(excluded.map(p => normalizePhone(p)).filter(Boolean));
        }

        let custom = await getSetting('targeting_custom_staff', userId);
        if (!custom && userId !== 3) custom = await getSetting('targeting_custom_staff', 3);
        if (!custom && userId !== 1) custom = await getSetting('targeting_custom_staff', 1);

        if (typeof custom === 'string' && custom.trim()) {
            try {
                const parsed = JSON.parse(custom);
                if (Array.isArray(parsed)) customList = parsed;
            } catch (_) {}
        } else if (Array.isArray(custom)) {
            customList = custom;
        }
    } catch (err) {
        console.error('Error fetching targeting settings:', err.message);
    }

    if (!Array.isArray(customList)) customList = [];
    return { excludedSet, customList };
}

/**
 * Check if the sender is an authorized staff member for Targeting
 */
export async function isTargetingStaffAuthorized(phoneNumber, userId = 3) {
    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return false;

    // 1. Explicit Whitelist: Rady (01092308465)
    if (cleanPhone === '01092308465' || cleanPhone.endsWith('1092308465')) {
        return { isAuthorized: true, name: 'أ. راضي', role: 'admin' };
    }

    // 2. Check Excluded Phones
    const { excludedSet, customList } = await getTargetingConfigSettings(userId);
    if (excludedSet.has(cleanPhone)) {
        return false;
    }

    // 3. Check Custom Added Staff
    const customMatch = customList.find(c => normalizePhone(c.phone) === cleanPhone);
    if (customMatch) {
        return {
            isAuthorized: true,
            name: customMatch.name || 'مسؤول مخصص',
            role: customMatch.role || 'sales',
            roleLabel: customMatch.roleLabel || 'مسؤول استهداف وميديا باير'
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
        console.error('Error checking targeting staff authorization:', e.message);
    }

    return false;
}

/**
 * Get full list of staff members for Targeting settings tab
 */
export async function getTargetingAuthorizedStaff(userId = 3) {
    const { excludedSet, customList } = await getTargetingConfigSettings(userId);

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
        console.error('Error fetching staff users for targeting:', e.message);
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
                              u.role === 'admin' ? 'مدير' : 'مسؤول مبيعات واستهداف';
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
            let cleanRoleLabel = (c.roleLabel || 'مسؤول استهداف وميديا باير').replace(/\s*\(.*?\)/g, '').trim();
            if (!cleanRoleLabel) cleanRoleLabel = 'مسؤول استهداف وميديا باير';
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
 * Add a new authorized phone number for Targeting
 */
export async function addTargetingStaff(rawPhone, name = '', roleLabel = 'مسؤول استهداف وميديا باير', userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean || clean.length < 10) {
        return { success: false, message: '⚠️ رقم الهاتف غير صحيح. يرجى إدخال رقم هاتف مصري صالح (مثال: 01012345678).' };
    }

    if (clean === '01092308465') {
        return { success: false, message: 'ℹ️ هذا الرقم هو رقم الأدمن الأساسي ومسجل ومفعل دائماً.' };
    }

    const { excludedSet, customList } = await getTargetingConfigSettings(userId);

    // If it was previously excluded, unexclude it
    if (excludedSet.has(clean)) {
        excludedSet.delete(clean);
        const updatedExcluded = Array.from(excludedSet);
        await setSetting('targeting_excluded_phones', JSON.stringify(updatedExcluded), userId);
        if (userId !== 1) await setSetting('targeting_excluded_phones', JSON.stringify(updatedExcluded), 1);
    }

    const existingIdx = customList.findIndex(c => normalizePhone(c.phone) === clean);
    const finalName = (name || '').trim() || `مسؤول ${clean.slice(-4)}`;
    const finalRoleLabel = (roleLabel || 'مسؤول استهداف وميديا باير').replace(/\s*\(.*?\)/g, '').trim() || 'مسؤول استهداف وميديا باير';

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

    await setSetting('targeting_custom_staff', JSON.stringify(customList), userId);
    if (userId !== 1) await setSetting('targeting_custom_staff', JSON.stringify(customList), 1);

    const updatedList = await getTargetingAuthorizedStaff(userId);
    return {
        success: true,
        message: `✅ تم إضافة الرقم ${clean} (${finalName}) إلى قائمة صلاحيات الاستهداف بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Remove a phone number from Targeting
 */
export async function removeTargetingStaff(rawPhone, userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean) {
        return { success: false, message: '⚠️ يرجى تحديد رقم الهاتف المراد حذفه.' };
    }

    if (clean === '01092308465') {
        return { success: false, message: '⚠️ لا يمكن حذف رقم الأدمن الرئيسي للنظام (أ. راضي).' };
    }

    const { excludedSet, customList } = await getTargetingConfigSettings(userId);

    // 1. Remove from customList if present
    const updatedCustom = customList.filter(c => normalizePhone(c.phone) !== clean);
    if (updatedCustom.length !== customList.length) {
        await setSetting('targeting_custom_staff', JSON.stringify(updatedCustom), userId);
        if (userId !== 1) await setSetting('targeting_custom_staff', JSON.stringify(updatedCustom), 1);
    }

    // 2. Add to excludedSet so even if it exists in User table, it will be excluded
    excludedSet.add(clean);
    const updatedExcluded = Array.from(excludedSet);
    await setSetting('targeting_excluded_phones', JSON.stringify(updatedExcluded), userId);
    if (userId !== 1) await setSetting('targeting_excluded_phones', JSON.stringify(updatedExcluded), 1);

    const updatedList = await getTargetingAuthorizedStaff(userId);
    return {
        success: true,
        message: `🗑️ تم إزالة صلاحية الرقم ${clean} من خدمة الاستهدافات بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Check if the user is authorized to perform targeting audits
 */
export async function isAuthorizedForTargeting(phone, userId = 3) {
    if (!phone) return false;
    const clean = normalizePhone(phone);
    if (!clean) return false;

    // 1. Rady (01092308465)
    if (clean === '01092308465' || clean.endsWith('1092308465')) return true;

    // 2. Check dedicated Targeting Staff Authorization
    try {
        const targetingCheck = await isTargetingStaffAuthorized(clean, userId);
        if (targetingCheck && targetingCheck.isAuthorized) return true;
    } catch (_) {}

    // 3. Fallback: Ads Authorized Admins
    try {
        const adsAdmins = await getAdsAuthorizedAdmins(userId);
        if (adsAdmins.some(a => normalizePhone(a.phone) === clean)) return true;
    } catch (_) {}

    // 4. Fallback: Facebook Analysis Authorized Staff
    try {
        const staffCheck = await isFacebookAnalysisStaffAuthorized(phone, userId);
        if (staffCheck && staffCheck.isAuthorized) return true;
    } catch (_) {}

    return false;
}

/**
 * Handle incoming WhatsApp message for Campaign Targeting Audit
 */
export async function handleCampaignTargetingMessage({
    sock,
    remoteJid,
    phoneNumber,
    participantJid,
    text,
    userId = 3,
    io,
    isGroup = false
}) {
    if (!text || typeof text !== 'string') return { handled: false };
    const raw = text.trim();

    const isPlain = isPlainTargetingCommand(raw);
    const isCommand = isCampaignTargetingCommand(raw, remoteJid);

    if (!isPlain && !isCommand) {
        return { handled: false };
    }

    // Authorization verification
    const sender = phoneNumber || (participantJid ? participantJid.replace(/[^0-9]/g, '') : '');
    if (!isGroup) {
        const authorized = await isAuthorizedForTargeting(sender, userId);
        if (!authorized) {
            console.log(`🔒 [Campaign Targeting] Unauthorized private command from ${sender}`);
            return { handled: false };
        }
    }

    // If user wrote plain "استهداف" without campaign ID, send clear instruction
    if (isPlain) {
        const helpText = `ℹ️ يا غالي اكتبلي رقم الحملة أو الإعلان علشان أفحصه فوراً 🎯\n\n💡 *أمثلة للاستخدام:*\n- \`استهداف 120251807851810053\`\n- أو اكتب بعد الرقم اللي عايزه، مثلاً:\n  \`استهداف 120251807851810053 ركز على تجار الجملة ومحلات المحافظات\`\n  \`استهداف 120251807851810053 خلي التركيز على ستات البيوت في الصعيد\``;
        await replyToTargetingChat(sock, remoteJid, helpText, userId, io, isGroup);
        return { handled: true };
    }

    const campaignId = extractCampaignTargetingId(raw, remoteJid);
    if (!campaignId) {
        const helpText = `⚠️ يا غالي اكتب رقم الحملة الإعلانية مع ملاحظاتك علشان أربطهم ببعض وأفحصها فوراً 🎯\n\n💡 *مثال:* \`استهداف 120251807851810053 ركز على تجار المنصورة\``;
        await replyToTargetingChat(sock, remoteJid, helpText, userId, io, isGroup);
        return { handled: true };
    }

    // حفظ الحملة النشطة في جلسة المحادثة
    campaignTargetingSessions.set(remoteJid, {
        campaignId,
        updatedAt: Date.now()
    });

    console.log(`🎯 [Campaign Targeting] Starting audit for Campaign ID: ${campaignId} from ${sender} (raw: "${raw}")`);

    // تجهيز وتنظيف نص الرسالة المرسل للـ API
    let cleanTextToSend = raw;
    const isFollowup = !raw.includes(campaignId);
    if (isFollowup) {
        cleanTextToSend = `استهداف بديل ${campaignId} ${raw}`;
    } else {
        const strippedDirective = raw.replace(/^[\/\s]*(?:استهداف|targeting)\s*[:=\-]?\s*\d{6,20}\s*/i, '').trim();
        if (!strippedDirective) {
            cleanTextToSend = `استهداف ${campaignId}`;
        }
    }

    // Immediate acknowledgment
    const ackText = isFollowup
        ? `🦅 جاري فحص وتوليد استهداف بديل ومخصص للحملة (\`${campaignId}\`) بناءً على طلبك وملاحظاتك... ⏳`
        : `🦅 جاري فحص وتدقيق استهداف الحملة (\`${campaignId}\`) بالذكاء الاصطناعي ومطابقته لمحتوى الإعلان وقاموس ميتا... ⏳`;
    await replyToTargetingChat(sock, remoteJid, ackText, userId, io, isGroup);

    // Keep typing presence active
    const stopComposing = startContinuousComposing(sock, remoteJid);

    try {
        const result = await callCampaignTargetingApi(cleanTextToSend, campaignId);
        stopComposing();

        if (!result || !result.success) {
            const errDetail = result?.error || result?.message || '';
            console.error(`❌ [Campaign Targeting] API failed for ${campaignId}:`, errDetail);
            let friendlyErr = `⚠️ يا غالي اتأكد من رقم الحملة، أو تأكد إن الحساب الإعلاني فيه صلاحية للوصول للحملة دي.`;
            if (errDetail && !errDetail.includes('404') && !errDetail.includes('not found') && !errDetail.includes('Campaign not found')) {
                friendlyErr += `\n\n📌 *السبب:* ${errDetail}`;
            }
            await replyToTargetingChat(sock, remoteJid, friendlyErr, userId, io, isGroup);
            return { handled: true };
        }

        // استخراج أجزاء الرسالة (part1 / part2 أو formatted_message_parts أو formatted_message)
        let partsToSend = [];
        if (result.part1 || result.part2) {
            if (result.part1) partsToSend.push(result.part1);
            if (result.part2) partsToSend.push(result.part2);
        } else if (Array.isArray(result.formatted_message_parts) && result.formatted_message_parts.length > 0) {
            partsToSend = result.formatted_message_parts;
        } else if (result.formatted_message) {
            partsToSend = [result.formatted_message];
        }

        if (partsToSend.length === 0) {
            const emptyText = `⚠️ يا غالي اتأكد من رقم الحملة، أو تأكد إن الحساب الإعلاني فيه صلاحية للوصول للحملة دي وتأكد إن مجموعاتها الإعلانية نشطة.`;
            await replyToTargetingChat(sock, remoteJid, emptyText, userId, io, isGroup);
            return { handled: true };
        }

        const adsetsCount = result.adsets_count || (Array.isArray(result.adsets) ? result.adsets.length : 1);

        // إرسال الأجزاء بالتسلسل مع التنسيق المتقن (المقترحات مباشرة، السلوكيات كل واحدة على سطر، وإلغاء تكرار المجموعة)
        for (let i = 0; i < partsToSend.length; i++) {
            const rawPartText = partsToSend[i];
            const formattedPart = formatTargetingReportPart(rawPartText, adsetsCount);
            await replyToTargetingChat(sock, remoteJid, formattedPart, userId, io, isGroup);

            // انتظار فاصل زمني طبيعي بين الجزأين
            if (i < partsToSend.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        return { handled: true };
    } catch (err) {
        stopComposing();
        console.error(`💥 [Campaign Targeting Exception] for ${campaignId}:`, err);
        const errText = `⚠️ يا غالي حصل خطأ غير متوقع أثناء فحص استهداف الحملة (\`${campaignId}\`): ${err.message}`;
        await replyToTargetingChat(sock, remoteJid, errText, userId, io, isGroup);
        return { handled: true };
    }
}
