import fetch from 'node-fetch';
import { Op } from 'sequelize';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Message from '../models/Message.js';
import { getSetting, setSetting } from './settingsService.js';
import { sendSystemNotification, normalizePhoneToJid } from './notificationDispatcher.js';

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

// Configuration for Eina Souq (عين السوق) APIs
const COMPETITOR_API_BASE = 'https://einasouq.bird-ads.com/api/v1/merchant';
const COMPETITOR_API_KEY = 'fastorder_merchant_secure_api_key_2026';

// Active in-memory competitor sessions
// Key: clean staff phone (e.g. '01092308465')
// Value: { inSession: true, lastKeyword: '', currentPage: 1, lastActive: timestamp }
export const competitorSessions = new Map();

/**
 * Check if the user is currently in an active competitor spy session
 */
export function isUserInCompetitorSession(phone) {
    const clean = normalizePhone(phone);
    if (!clean) return false;
    const session = competitorSessions.get(clean);
    if (!session || !session.inSession) return false;

    // Auto-expire session after 30 minutes of inactivity
    if (Date.now() - session.lastActive > 30 * 60 * 1000) {
        competitorSessions.delete(clean);
        return false;
    }
    return true;
}

/**
 * Check if the text is a competitor spy command
 */
export function isCompetitorCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return /^(\/|\s)*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق|كلمات|الكلمات|keywords|نوتش|تقرير|ads|حملات|المزيد|more|خروج|close|حفظ|استخراج|crm|سجل|تسجيل)($|\s)/i.test(trimmed);
}

/**
 * Helper: Start continuous typing presence ("يكتب الآن...") while waiting for async work.
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
    const typingDuration = Math.min(6500, Math.max(2500, Math.floor(textLen * 12) + Math.floor(Math.random() * 1200) + 800));

    let presenceInterval = null;
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            presenceInterval = setInterval(() => {
                sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            }, 4000);
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
        console.error('❌ [replyToStaff - Competitor] WhatsApp send error:', sendErr.message);
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
        console.error('⚠️ [replyToStaff - Competitor] SQL logging error:', dbErr.message);
    }
}

/**
 * Get internal sets of excluded phones and custom staff for Competitors
 */
async function getCompetitorConfigSettings(userId = 3) {
    const excludedSet = new Set();
    let customList = [];

    try {
        let excluded = await getSetting('competitor_excluded_phones', userId);
        if (!excluded && userId !== 1) {
            excluded = await getSetting('competitor_excluded_phones', 1);
        }
        if (typeof excluded === 'string') {
            try {
                const parsed = JSON.parse(excluded);
                if (Array.isArray(parsed)) parsed.forEach(p => excludedSet.add(normalizePhone(p)));
                else excluded.split(',').forEach(p => excludedSet.add(normalizePhone(p)));
            } catch (_) {
                excluded.split(',').forEach(p => excludedSet.add(normalizePhone(p)));
            }
        } else if (Array.isArray(excluded)) {
            excluded.forEach(p => excludedSet.add(normalizePhone(p)));
        }

        let custom = await getSetting('competitor_custom_staff', userId);
        if (!custom && userId !== 1) {
            custom = await getSetting('competitor_custom_staff', 1);
        }
        if (typeof custom === 'string') {
            try {
                customList = JSON.parse(custom);
            } catch (_) {}
        } else if (Array.isArray(custom)) {
            customList = custom;
        }
    } catch (err) {
        console.error('Error fetching competitor settings:', err.message);
    }

    if (!Array.isArray(customList)) customList = [];
    return { excludedSet, customList };
}

/**
 * Check if the sender is an authorized staff member for Competitor Spy.
 * Whitelists Rady (01092308465), custom numbers, and active users unless excluded.
 */
export async function isCompetitorStaffAuthorized(phoneNumber, userId = 3) {
    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return false;

    // 1. Explicit Whitelist: Rady (01092308465)
    if (cleanPhone === '01092308465' || cleanPhone.endsWith('1092308465')) {
        return { isAuthorized: true, name: 'أ. راضي', role: 'admin' };
    }

    // 2. Check Excluded Phones
    const { excludedSet, customList } = await getCompetitorConfigSettings(userId);
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
        const { Op } = await import('sequelize');
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
        console.error('Error checking competitor staff authorization:', e.message);
    }

    return false;
}

/**
 * Get full list of staff members for Competitors settings tab
 */
export async function getCompetitorAuthorizedStaff(userId = 3) {
    const { excludedSet, customList } = await getCompetitorConfigSettings(userId);

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
        console.error('Error fetching staff users for competitor:', e.message);
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
 * Add a new authorized phone number for Competitors
 */
export async function addCompetitorStaff(rawPhone, name = '', roleLabel = 'مسؤول مبيعات', userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean || clean.length < 10) {
        return { success: false, message: '⚠️ رقم الهاتف غير صحيح. يرجى إدخال رقم هاتف مصري صالح (مثال: 01012345678).' };
    }

    if (clean === '01092308465') {
        return { success: false, message: 'ℹ️ هذا الرقم هو رقم الأدمن الأساسي ومسجل ومفعل دائماً.' };
    }

    const { excludedSet, customList } = await getCompetitorConfigSettings(userId);

    // If it was previously excluded, unexclude it
    if (excludedSet.has(clean)) {
        excludedSet.delete(clean);
        const updatedExcluded = Array.from(excludedSet);
        await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), userId);
        if (userId !== 1) await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), 1);
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

    await setSetting('competitor_custom_staff', JSON.stringify(customList), userId);
    if (userId !== 1) await setSetting('competitor_custom_staff', JSON.stringify(customList), 1);

    const updatedList = await getCompetitorAuthorizedStaff(userId);
    return {
        success: true,
        message: `✅ تم إضافة الرقم ${clean} (${finalName}) إلى قائمة صلاحيات المنافسين بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Remove a custom phone number from Competitors
 */
export async function removeCompetitorStaff(rawPhone, userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean) {
        return { success: false, message: '⚠️ يرجى تحديد رقم الهاتف المراد حذفه.' };
    }

    if (clean === '01092308465') {
        return { success: false, message: '⚠️ لا يمكن حذف رقم الأدمن الرئيسي للنظام (أ. راضي).' };
    }

    const { excludedSet, customList } = await getCompetitorConfigSettings(userId);

    // 1. Remove from customList if present
    const updatedCustom = customList.filter(c => normalizePhone(c.phone) !== clean);
    if (updatedCustom.length !== customList.length) {
        await setSetting('competitor_custom_staff', JSON.stringify(updatedCustom), userId);
        if (userId !== 1) await setSetting('competitor_custom_staff', JSON.stringify(updatedCustom), 1);
    }

    // 2. Add to excludedSet so even if it exists in User table, it will be disabled
    excludedSet.add(clean);
    const updatedExcluded = Array.from(excludedSet);
    await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), userId);
    if (userId !== 1) await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), 1);

    const updatedList = await getCompetitorAuthorizedStaff(userId);
    return {
        success: true,
        message: `🗑️ تم إزالة صلاحية الرقم ${clean} من خدمة المنافسين بنجاح.`,
        staffList: updatedList
    };
}

/**
 * Toggle (enable/disable) staff permission for Competitors
 */
export async function toggleCompetitorStaff(rawPhone, userId = 3) {
    const clean = normalizePhone(rawPhone);
    if (!clean) {
        return { success: false, message: '⚠️ يرجى تحديد رقم الهاتف.' };
    }

    if (clean === '01092308465') {
        return { success: false, message: '⚠️ لا يمكن تعطيل صلاحية الأدمن الأساسي (أ. راضي).' };
    }

    const { excludedSet } = await getCompetitorConfigSettings(userId);
    let isNowActive = false;

    if (excludedSet.has(clean)) {
        // Was disabled -> Enable it
        excludedSet.delete(clean);
        isNowActive = true;
    } else {
        // Was active -> Disable it
        excludedSet.add(clean);
        isNowActive = false;
    }

    const updatedExcluded = Array.from(excludedSet);
    await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), userId);
    if (userId !== 1) await setSetting('competitor_excluded_phones', JSON.stringify(updatedExcluded), 1);

    const updatedList = await getCompetitorAuthorizedStaff(userId);
    return {
        success: true,
        isActive: isNowActive,
        message: isNowActive 
            ? `🟢 تم تفعيل صلاحية الرقم ${clean} في خدمة المنافسين.`
            : `🔴 تم إيقاف صلاحية الرقم ${clean} في خدمة المنافسين.`,
        staffList: updatedList
    };
}

/**
 * Helper: get number badge
 */
function getNumberBadge(num) {
    const badges = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    if (num >= 1 && num <= 10) return badges[num - 1];
    return `*${num}.*`;
}

/**
 * Call External API 1: Suggest Keywords (Vertex AI) with pagination support
 */
export async function fetchSuggestedKeywords(niche, country = 'EG', page = 1, startIndex = 0) {
    try {
        // Prepare request body with page and more parameters
        // When page > 1, send modified niche prompt so Vertex AI bypasses page 1 cache if backend doesn't handle page natively yet
        const effectiveNiche = (page > 1) 
            ? `${niche} - زوايا بحثية وأفكار إعلانية متقدمة وإضافية دفعة ${page}`
            : niche;

        const res = await fetch(`${COMPETITOR_API_BASE}/suggest-keywords`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': COMPETITOR_API_KEY
            },
            body: JSON.stringify({ 
                niche: effectiveNiche, 
                query: effectiveNiche, 
                country,
                page: page,
                more: true
            })
        });

        const data = await res.json().catch(() => null);
        if (data && data.error) {
            return { success: false, message: `⚠️ ${data.error}` };
        }

        if (data && (data.angles || data.suggested_keywords || data.keywords_list)) {
            let totalIndex = startIndex;
            const newKeywords = [];

            const cleanNicheTitle = (data.query || niche).replace(/\s*-\s*زوايا[\s\S]*$/, '');
            let formattedMsg = `🎯 *الكلمات والزوايا البحثية لمجال:* ${cleanNicheTitle}${page > 1 ? ` (الدفعة ${page})` : ''}\n` +
                               `🌍 *الدولة:* ${data.country === 'EG' ? 'مصر 🇪🇬' : (data.country || 'مصر 🇪🇬')}\n` +
                               `══════════════════════`;

            if (Array.isArray(data.angles) && data.angles.length > 0) {
                for (const angle of data.angles) {
                    const catName = angle.category || 'عام';
                    const kwList = Array.isArray(angle.keywords) ? angle.keywords : [];
                    if (kwList.length === 0) continue;

                    formattedMsg += `\n\n📌 *زاوية: ${catName}*`;
                    for (const kwItem of kwList) {
                        totalIndex++;
                        const kw = typeof kwItem === 'string' ? kwItem : (kwItem.keyword || String(kwItem));
                        newKeywords.push(kw);
                        formattedMsg += `\n${getNumberBadge(totalIndex)} ${kw}`;
                    }
                }
            } else if (Array.isArray(data.suggested_keywords) && data.suggested_keywords.length > 0) {
                formattedMsg += `\n\n💡 *أقوى الكلمات المفتاحية:*`;
                for (const kwItem of data.suggested_keywords) {
                    totalIndex++;
                    const kw = typeof kwItem === 'string' ? kwItem : (kwItem.keyword || String(kwItem));
                    newKeywords.push(kw);
                    formattedMsg += `\n${getNumberBadge(totalIndex)} ${kw}`;
                }
            } else if (Array.isArray(data.keywords_list) && data.keywords_list.length > 0) {
                formattedMsg += `\n\n💡 *أقوى الكلمات المفتاحية:*`;
                for (const kw of data.keywords_list) {
                    totalIndex++;
                    newKeywords.push(kw);
                    formattedMsg += `\n${getNumberBadge(totalIndex)} ${kw}`;
                }
            }

            const nextMoreNum = totalIndex + 1;
            formattedMsg += `\n\n${getNumberBadge(nextMoreNum)} المزيد ⏭️`;

            return { 
                success: true, 
                message: formattedMsg,
                keywords: newKeywords,
                totalIndex: totalIndex,
                moreIndex: nextMoreNum
            };
        } else if (data && data.formatted_message) {
            let cleaned = data.formatted_message
                .replace(/🔗[^\n]*\n?/g, '')
                .replace(/💡\s*\*تحليل الذكاء الاصطناعي:[\s\S]*$/i, '')
                .replace(/👉\s*لجلب إعلانات المنافسين[\s\S]*$/i, '')
                .trim();
            return { success: true, message: cleaned, keywords: data.keywords_list || [] };
        }

        return { success: false, message: '⚠️ تعذر جلب الكلمات المقترحة حالياً. يرجى المحاولة لاحقاً.' };
    } catch (err) {
        console.error('❌ [fetchSuggestedKeywords] Error:', err.message);
        return { success: false, message: `⚠️ حدث خطأ في الاتصال بالخدمة: ${err.message}` };
    }
}

/**
 * Helper: Extract valid Egyptian phone numbers and filter out random IDs
 */
function extractValidPhones(text, phoneNumbersList = []) {
    const valid = new Set();
    if (Array.isArray(phoneNumbersList)) {
        for (const p of phoneNumbersList) {
            const clean = String(p).replace(/[^0-9]/g, '');
            let norm = clean;
            if (norm.startsWith('20')) norm = norm.slice(2);
            if (norm.startsWith('0')) norm = norm.slice(1);
            if (norm.length === 10 && ['10', '11', '12', '15'].includes(norm.slice(0, 2))) {
                valid.add('0' + norm);
            }
        }
    }
    if (text) {
        const regex = /(?:(?:\+?20|0020)[\s.-]?)?0?1[0125][\s.-]?\d{3,4}[\s.-]?\d{4}/g;
        const matches = text.match(regex);
        if (matches) {
            for (const m of matches) {
                const clean = m.replace(/[^0-9]/g, '');
                let norm = clean;
                if (norm.startsWith('20')) norm = norm.slice(2);
                if (norm.startsWith('0')) norm = norm.slice(1);
                if (norm.length === 10 && ['10', '11', '12', '15'].includes(norm.slice(0, 2))) {
                    valid.add('0' + norm);
                }
            }
        }
    }
    return Array.from(valid);
}

/**
 * Call External API 2: Competitor Live Ads (Facebook Ad Library with Pagination)
 */
export async function fetchCompetitorAds(keyword, page = 1, limit = 5, country = 'EG', startIndex = 0) {
    try {
        const res = await fetch(`${COMPETITOR_API_BASE}/competitor-ads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': COMPETITOR_API_KEY
            },
            body: JSON.stringify({ keyword, page, limit, country })
        });

        const data = await res.json().catch(() => null);
        if (data && data.error) {
            return { success: false, message: `⚠️ ${data.error}` };
        }

        const ads = data?.ads || [];
        if (ads.length === 0) {
            return { 
                success: false, 
                message: page > 1 
                    ? `🏁 انتهت جميع الإعلانات المتاحة لكلمة *"${keyword}"*.` 
                    : `⚠️ لم يتم العثور على إعلانات لكلمة *"${keyword}"* حالياً.`
            };
        }

        let msg = `📊 *إعلانات المنافسين من مكتبة الإعلانات*\n` +
                  `🔍 *كلمة البحث:* "${keyword}"\n` +
                  `🌍 *الدولة:* ${data.country === 'EG' ? 'مصر 🇪🇬' : (data.country || 'مصر 🇪🇬')}\n` +
                  `📄 *الدفعة:* رقم ${page} (عرض ${ads.length} إعلانات)\n` +
                  `══════════════════════`;

        let currentIndex = startIndex;

        for (const ad of ads) {
            currentIndex++;
            const badge = getNumberBadge(currentIndex);

            msg += `\n\n${badge} *${ad.page_name || 'صفحة معلن'}*`;
            if (ad.cta_label) msg += `\n• 🎯 الهدف: *${ad.cta_label}*`;
            if (ad.duration_text) msg += `\n• ⏳ مدة التشغيل: *${ad.duration_text}*${ad.start_date ? ` (منذ ${ad.start_date})` : ''}`;
            if (ad.media_type_label) msg += `\n• 🎬 نوع الإعلان: *${ad.media_type_label}*`;
            if (ad.platforms_label) msg += `\n• 📱 المنصات: *${ad.platforms_label}*`;

            // استخراج وتدقيق أرقام التواصل الحقيقية واستبعاد المعرفات العشوائية
            const validPhones = extractValidPhones(ad.primary_text, ad.phone_numbers);
            if (validPhones.length > 0) {
                msg += `\n• 📞 رقم التواصل: \`${validPhones.join('`, `')}\``;
                const p = validPhones[0];
                const intl = p.startsWith('0') ? (`20${p.slice(1)}`) : p;
                msg += `\n• 💬 مراسلة واتساب: https://wa.me/${intl}`;
            } else if (ad.cta_type === 'WHATSAPP') {
                msg += `\n• 💬 إعلان واتساب: (الزر مربوط بواتساب المعلن)`;
            }

            // رابط صفحة الفيسبوك ورابط مراسلة ماسنجر
            if (ad.page_profile_url) {
                msg += `\n• 🌐 صفحة الفيسبوك: ${ad.page_profile_url}`;
                const m = ad.page_profile_url.match(/facebook\.com\/([^\/\?]+)/);
                if (m && m[1] && !['profile.php', 'pages'].includes(m[1])) {
                    msg += `\n• 📩 مراسلة ماسنجر: https://m.me/${m[1]}`;
                }
            }

            // النص الإعلاني كاملاً بدون أي اقتطاع
            if (ad.primary_text) {
                msg += `\n• 📝 نص الإعلان بالكامل:\n"${ad.primary_text.trim()}"`;
            }

            // رابط الإعلان في مكتبة الإعلانات
            if (ad.ad_library_url) {
                msg += `\n• 🔗 رابط الإعلان بالمكتبة: ${ad.ad_library_url}`;
            }
        }

        const hasMore = (data.pagination?.has_more !== false && ads.length >= limit);
        let moreIndex = null;
        let saveIndex = null;

        if (hasMore) {
            moreIndex = currentIndex + 1;
            saveIndex = currentIndex + 2;
            msg += `\n\n${getNumberBadge(moreIndex)} المزيد ⏭️`;
            msg += `\n${getNumberBadge(saveIndex)} استخراج الأرقام وحفظ في الـ CRM 📥`;
        } else {
            saveIndex = currentIndex + 1;
            msg += `\n\n${getNumberBadge(saveIndex)} استخراج الأرقام وحفظ في الـ CRM 📥`;
            msg += `\n🏁 *انتهت جميع الإعلانات المتاحة لهذه الكلمة.*`;
        }

        return { 
            success: true, 
            message: msg,
            ads: ads,
            adsCount: ads.length,
            has_more: hasMore,
            totalIndex: currentIndex,
            moreIndex: moreIndex,
            saveIndex: saveIndex
        };
    } catch (err) {
        console.error('❌ [fetchCompetitorAds] Error:', err.message);
        return { success: false, message: `⚠️ حدث خطأ في سحب إعلانات المنافسين: ${err.message}` };
    }
}

/**
 * Call External API 3: Campaigns Summary
 */
export async function fetchCampaignSummary(accountId, period = 'lifetime') {
    try {
        const cleanActId = String(accountId).replace(/[^0-9]/g, '');
        const res = await fetch(`${COMPETITOR_API_BASE}/campaigns-summary`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': COMPETITOR_API_KEY
            },
            body: JSON.stringify({ 
                account_id: cleanActId,
                act_id: cleanActId,
                period: period || 'lifetime' 
            })
        });

        const data = await res.json().catch(() => null);
        if (!data || !data.success) {
            return { 
                success: false, 
                message: `⚠️ تعذر جلب تقرير الحساب الإعلاني: ${data?.error || 'رقم الحساب غير صالح أو لا توجد بيانات متاحة.'}` 
            };
        }

        if (data.formatted_message) {
            return { success: true, message: data.formatted_message };
        }

        // Format summary manually if formatted_message is not returned
        const s = data.summary || {};
        const acc = data.account || {};
        const periodLabels = {
            today: 'اليوم',
            yesterday: 'أمس',
            last_7d: 'آخر 7 أيام',
            this_month: 'هذا الشهر',
            lifetime: 'شامل كامل الفترة'
        };
        const periodLabel = periodLabels[period] || period;

        let msg = `📊 *تقرير أداء الحساب الإعلاني* 🦅\n`;
        msg += `👤 *اسم الحساب:* ${acc.name || s.account_name || 'حساب إعلاني'} (\`${cleanActId}\`)\n`;
        msg += `💰 *الرصيد المتاح:* ${acc.balance_formatted || s.account_balance_formatted || '0 EGP'}\n`;
        msg += `⏳ *الفترة:* ${periodLabel}\n`;
        msg += `══════════════════════\n`;
        msg += `💵 *إجمالي الصرف:* ${s.total_spend || 0} ${data.currency || 'EGP'}\n`;
        msg += `🎯 *النتائج (${s.result_label || 'رسائل'}):* ${s.total_results || s.total_conversations || 0}\n`;
        msg += `📈 *متوسط تكلفة النتيجة (CPA):* ${s.average_cpa || 0} ${data.currency || 'EGP'}\n`;
        msg += `👥 *الوصول (Reach):* ${s.total_reach ? s.total_reach.toLocaleString('ar-EG') : 0}\n`;
        msg += `👁️ *الظهور (Impressions):* ${s.total_impressions ? s.total_impressions.toLocaleString('ar-EG') : 0}\n`;
        msg += `👆 *النقرات (Clicks):* ${s.total_clicks || 0} (CTR: ${s.average_ctr || 0}%)\n`;
        msg += `🔥 *الحملات النشطة:* ${s.active_campaigns_count || 0} من أصل ${s.total_campaigns_count || 0}\n`;
        msg += `══════════════════════\n`;
        msg += `🦅 *عين السوق - تحليلات الإعلانات الذكية*`;

        return { success: true, message: msg };
    } catch (err) {
        console.error('❌ [fetchCampaignSummary] Error:', err.message);
        return { success: false, message: `⚠️ حدث خطأ أثناء سحب تقرير الحساب: ${err.message}` };
    }
}

/**
 * Extract phone numbers from current batch of competitor ads and save them to CRM (customers table)
 */
export async function saveCompetitorLeadsToCrm({ sock, remoteJid, phoneNumber, userId = 3, io, session }) {
    if (!session || !session.currentAds || session.currentAds.length === 0) {
        await replyToStaff(
            sock,
            remoteJid,
            '⚠️ لا توجد إعلانات معروضة حالياً لاستخراج أرقامها!\nابدأ بالبحث عن إعلانات منافسين أولاً بكتابة: */منافسين [الكلمة]*',
            userId,
            io
        );
        return { handled: true };
    }

    // إرسال رسالة انتظار ومحاكاة الكتابة المستمرة
    await replyToStaff(sock, remoteJid, '⏳ جاري استخراج وتدقيق أرقام الهواتف وحفظها في الـ CRM...', userId, io);
    const stopComposing = startContinuousComposing(sock, remoteJid);

    try {
        // 1. تصفية الإعلانات التي تحتوي على أرقام هواتف صالحة فقط
        const adsWithPhones = [];
        for (const ad of session.currentAds) {
            const validPhones = extractValidPhones(ad.primary_text, ad.phone_numbers);
            if (validPhones.length > 0) {
                adsWithPhones.push({
                    ad,
                    validPhones,
                    primaryPhone: validPhones[0],
                    secondPhone: validPhones.length > 1 ? validPhones[1] : null
                });
            }
        }

        if (adsWithPhones.length === 0) {
            stopComposing();
            let emptyMsg = `⚠️ لم يتم العثور على أرقام هواتف في هذه الدفعة من الإعلانات.\n` +
                           `• أغلب هذه الإعلانات تعتمد على المراسلة المباشرة عبر ماسنجر أو التحويل إلى متجر إلكتروني.\n` +
                           `• يمكنك الضغط على روابط ماسنجر المرفقة بكل إعلان للتواصل معهم مباشرة.`;
            if (session.adsMoreIndex) {
                emptyMsg += `\n\n${getNumberBadge(session.adsMoreIndex)} المزيد ⏭️`;
            }
            await replyToStaff(sock, remoteJid, emptyMsg, userId, io);
            return { handled: true };
        }

        // 2. البحث عن موظف السيلز المسؤول بناءً على رقم المرسل
        let assignedToUserId = null;
        let salesName = 'بدون تعيين (غير محدد)';

        const cleanPhone = normalizePhone(phoneNumber);
        const cleanNoZero = cleanPhone.startsWith('0') ? cleanPhone.substring(1) : cleanPhone;

        try {
            const user = await User.findOne({
                where: {
                    [Op.or]: [
                        { phone: cleanPhone },
                        { phone: '2' + cleanPhone },
                        { phone: '20' + cleanNoZero },
                        { phone: cleanNoZero },
                        { phone: '0' + cleanNoZero },
                        { notificationPhone: cleanPhone },
                        { notificationPhone: '20' + cleanNoZero }
                    ]
                }
            });

            if (user) {
                assignedToUserId = user.id;
                salesName = user.fullName || user.username || `موظف #${user.id}`;
            } else if (cleanPhone === '01092308465' || cleanPhone.endsWith('1092308465')) {
                // الحساب الإداري لأ. راضي
                const radyUser = await User.findOne({
                    where: {
                        [Op.or]: [
                            { username: 'rady' },
                            { role: 'super_admin' },
                            { id: userId }
                        ]
                    }
                });
                if (radyUser) {
                    assignedToUserId = radyUser.id;
                    salesName = radyUser.fullName || radyUser.username || 'أ. راضي';
                } else {
                    salesName = 'أ. راضي (إدارة)';
                }
            }
        } catch (uErr) {
            console.error('❌ [saveCompetitorLeadsToCrm] Error finding sales user:', uErr.message);
        }

        // 3. حفظ كل عميل في قاعدة البيانات في جدول customers
        const targetUserId = userId || 3;
        const savedLeads = [];
        let alreadyExistingCount = 0;

        for (const item of adsWithPhones) {
            const { ad, primaryPhone, secondPhone } = item;

            // التحقق من وجود العميل مسبقاً لمنع خطأ التكرار (Unique Constraint)
            let existing = null;
            try {
                existing = await Customer.findOne({
                    where: {
                        UserId: targetUserId,
                        phoneNumber: primaryPhone
                    }
                });
            } catch (findErr) {
                console.error('❌ [saveCompetitorLeadsToCrm] Error finding customer:', findErr.message);
            }

            // إعداد الملاحظات
            let noteParts = ['عميل من عين السوق'];
            if (secondPhone) {
                noteParts[0] = `عميل من عين السوق (رقم إضافي: ${secondPhone})`;
            }
            if (ad.page_profile_url) {
                noteParts.push(`صفحة الفيسبوك: ${ad.page_profile_url}`);
            }
            if (session.lastKeyword) {
                noteParts.push(`كلمة البحث: ${session.lastKeyword}`);
            }
            if (ad.cta_label) {
                noteParts.push(`الهدف: ${ad.cta_label}`);
            }
            const fullNotes = noteParts.join('\n');

            const intlPhone = primaryPhone.startsWith('0') ? `20${primaryPhone.slice(1)}` : primaryPhone;
            const pageName = (ad.page_name || 'صفحة معلن').trim();

            if (existing) {
                alreadyExistingCount++;
                // تحديث مسؤول المبيعات والملاحظات إن لم تكن معينة
                if (!existing.assignedToUserId && assignedToUserId) {
                    await existing.update({ assignedToUserId }).catch(() => {});
                }
                savedLeads.push({
                    name: existing.customerName || pageName,
                    phone: primaryPhone,
                    secondPhone,
                    intlPhone,
                    pageUrl: ad.page_profile_url || '',
                    isNew: false
                });
            } else {
                try {
                    const newCust = await Customer.create({
                        UserId: targetUserId,
                        customerName: pageName,
                        phoneNumber: primaryPhone,
                        remoteJid: normalizePhoneToJid(primaryPhone),
                        status: 'new',
                        source: 'عين السوق',
                        leadTemperature: 'warm',
                        assignedToUserId: assignedToUserId,
                        notes: fullNotes,
                        firstContactAt: new Date()
                    });

                    savedLeads.push({
                        name: newCust.customerName || pageName,
                        phone: primaryPhone,
                        secondPhone,
                        intlPhone,
                        pageUrl: ad.page_profile_url || '',
                        isNew: true
                    });

                    if (io && targetUserId) {
                        io.to(`user_${targetUserId}`).emit('customer_created', newCust);
                    }
                } catch (createErr) {
                    console.error(`❌ [saveCompetitorLeadsToCrm] Error creating customer ${primaryPhone}:`, createErr.message);
                }
            }
        }

        stopComposing();

        if (savedLeads.length === 0) {
            await replyToStaff(sock, remoteJid, '⚠️ تعذر حفظ العملاء في قاعدة البيانات. يرجى المحاولة مرة أخرى.', userId, io);
            return { handled: true };
        }

        // 4. إرسال إشعار فوري لجروب إشعارات Bird CRM (120363428750785329@g.us)
        const newLeadsCount = savedLeads.filter(l => l.isNew).length;
        const groupNotice = 
            `📥 *استخراج عملاء جدد من عين السوق (المنافسين)* 🦅\n` +
            `══════════════════════\n` +
            `👤 *الموظف المسؤول:* ${salesName}\n` +
            `🔍 *كلمة البحث:* "${session.lastKeyword || 'غير محدد'}"\n` +
            `📊 *إجمالي المستخرج:* ${savedLeads.length} عميل (${newLeadsCount} جديد)\n` +
            `📂 *حالة العملاء:* عميل جديد (new)\n` +
            `══════════════════════\n` +
            savedLeads.map((lead, i) => {
                let it = `${getNumberBadge(i + 1)} *${lead.name}*` +
                         `\n• 📞 الهاتف: \`${lead.phone}\``;
                if (lead.secondPhone) it += `\n• 📱 هاتف إضافي: \`${lead.secondPhone}\``;
                if (lead.pageUrl) it += `\n• 🌐 الصفحة: ${lead.pageUrl}`;
                it += `\n• 💬 واتساب: https://wa.me/${lead.intlPhone}`;
                return it;
            }).join('\n\n') +
            `\n══════════════════════\n` +
            `🦅 *نظام عين السوق - إدارة المبيعات CRM*`;

        try {
            const groupJid = '120363428750785329@g.us';
            if (typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('available', groupJid).catch(() => {});
                sock.sendPresenceUpdate('composing', groupJid).catch(() => {});
            }
            await sock.sendMessage(groupJid, { text: groupNotice });
            console.log(`✅ [Competitor] Sent lead notice directly to Bird CRM group (${groupJid})`);
        } catch (gErr) {
            console.warn(`⚠️ [Competitor] Direct send to group failed, using notification dispatcher:`, gErr.message);
            await sendSystemNotification({ userId: targetUserId, message: groupNotice, type: 'competitor_leads' }).catch(() => {});
        }

        // 5. الرد على الموظف بتأكيد الحفظ وإعادة إظهار رقم المزيد
        let staffReply = 
            `✅ *تم استخراج وحفظ (${savedLeads.length}) عميل في الـ CRM بنجاح!* 📥\n` +
            `══════════════════════\n` +
            `👤 *مسؤول المبيعات:* ${salesName}\n` +
            `📂 *حالة العملاء:* عميل جديد (new)\n` +
            `🔍 *كلمة البحث:* "${session.lastKeyword || ''}"\n` +
            `══════════════════════\n` +
            savedLeads.map((lead, i) => {
                let it = `${getNumberBadge(i + 1)} *${lead.name}*` +
                         `\n• 📞 رقم التواصل: \`${lead.phone}\``;
                if (lead.secondPhone) it += `\n• 📱 هاتف إضافي: \`${lead.secondPhone}\``;
                it += `\n• 💬 مراسلة واتساب: https://wa.me/${lead.intlPhone}`;
                if (lead.pageUrl) it += `\n• 🌐 رابط الصفحة: ${lead.pageUrl}`;
                return it;
            }).join('\n\n');

        if (alreadyExistingCount > 0) {
            staffReply += `\n\nℹ️ ملاحظة: تم تحديث بيانات ${alreadyExistingCount} عميل لأنهم مسجلين بالفعل مسبقاً.`;
        }

        staffReply += `\n══════════════════════\n` +
                      `📢 *تم إرسال إشعار فوري لجروب إشعارات Bird CRM.*\n\n`;

        if (session.adsMoreIndex) {
            staffReply += `${getNumberBadge(session.adsMoreIndex)} المزيد ⏭️`;
        } else {
            staffReply += `🏁 انتهت جميع الإعلانات المتاحة لهذه الكلمة.`;
        }

        await replyToStaff(sock, remoteJid, staffReply, userId, io);
        return { handled: true };
    } catch (saveError) {
        stopComposing();
        console.error('❌ [saveCompetitorLeadsToCrm] Fatal error:', saveError);
        await replyToStaff(sock, remoteJid, `⚠️ حدث خطأ أثناء حفظ العملاء: ${saveError.message}`, userId, io);
        return { handled: true };
    }
}

/**
 * Handle incoming staff message for Competitor Spy
 */
export async function handleCompetitorMessage({ sock, remoteJid, phoneNumber, text, userId = 3, io }) {
    if (!text || typeof text !== 'string') return { handled: false };

    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return { handled: false };

    const trimmed = text.trim();

    // Check authorization
    const auth = await isCompetitorStaffAuthorized(cleanPhone, userId);
    if (!auth) {
        return { handled: false };
    }

    const inSession = isUserInCompetitorSession(cleanPhone);
    const isCmd = isCompetitorCommand(trimmed);

    // If neither in session nor command, pass through
    if (!inSession && !isCmd) {
        return { handled: false };
    }

    // Initialize or get session
    let session = competitorSessions.get(cleanPhone);
    if (!session) {
        session = { inSession: false, lastKeyword: '', currentPage: 1, lastActive: Date.now() };
        competitorSessions.set(cleanPhone, session);
    }
    session.lastActive = Date.now();

    // ================================================================
    // Command: /خروج or خروج or /close (Exit Competitor Mode)
    // ================================================================
    if (/^(\/|\s)*(خروج|close|exit|إنهاء)$/i.test(trimmed)) {
        competitorSessions.delete(cleanPhone);
        await replyToStaff(
            sock, 
            remoteJid, 
            '🦅 تم الخروج من وضع "عين السوق" بنجاح.\nتقدر ترجع في أي وقت بكتابة: */منافسين*', 
            userId, 
            io
        );
        return { handled: true };
    }

    // ================================================================
    // Command: Main Menu (/منافسين or /spy or /سوق without parameters)
    // ================================================================
    if (/^(\/|\s)*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق)$/i.test(trimmed)) {
        session.inSession = true;
        const welcomeMsg = 
            `🦅 مرحباً بك في *عين السوق* - رادارك الذكي للمنافسين وتحليل الإعلانات!\n\n` +
            `أنا جاهز أساعدك في المهام دي مباشرة:\n\n` +
            `1️⃣ *فحص وسحب إعلانات المنافسين الحية:*\n` +
            `اكتب: */منافسين [الكلمة البحثية أو المنتج]*\n` +
            `👈 مثال: \`/منافسين ساعات رجالي\` أو \`/منافسين فساتين سواريه\`\n\n` +
            `2️⃣ *اقتراح الكلمات المفتاحية وزوايا الإعلانات (Vertex AI):*\n` +
            `اكتب: */كلمات [مجالك أو منتجك]*\n` +
            `👈 مثال: \`/كلمات ملابس حريمي\` أو \`/كلمات مطاعم\`\n\n` +
            `3️⃣ *تقارير أداء الحسابات الإعلانية الممولة:*\n` +
            `اكتب: */تقرير [رقم الحساب]*\n` +
            `👈 مثال: \`/تقرير 165453869752274\`\n\n` +
            `══════════════════════\n` +
            `💡 *ميزة الجلسة الذكية:* بما إنك فتحت عين السوق، تقدر تكتب أي كلمة بحثية فوراً بدون كتابة سلاش، ولما تخلص اكتب */خروج*. قولي حابب نبدأ بإيه؟`;

        await replyToStaff(sock, remoteJid, welcomeMsg, userId, io);
        return { handled: true };
    }

    // ================================================================
    // Command: /كلمات [المجال] or /keywords [المجال]
    // ================================================================
    if (/^[\/\s]*(كلمات|الكلمات|keywords|نوتش)($|\s)/i.test(trimmed)) {
        let niche = trimmed.replace(/^[\/\s]*(كلمات|الكلمات|keywords|نوتش)\s*/i, '').trim();
        if (niche) {
            niche = niche.replace(/^(مجال|نشاط|شغال\s*في|ببيع|عايز\s*كلمات\s*لـ?|عايز\s*كلمات\s*عن)\s+/i, '').trim() || niche;
        }

        if (!niche) {
            await replyToStaff(
                sock, 
                remoteJid, 
                '⚠️ يرجى كتابة المجال المطلوب بعد الأمر.\nمثال: */كلمات ملابس* أو */كلمات أحذية رياضية*', 
                userId, 
                io
            );
            return { handled: true };
        }

        session.lastType = 'keywords';
        session.lastNiche = niche;
        session.keywordPage = 1;

        await replyToStaff(sock, remoteJid, `⏳ جاري تحليل مجال *"${niche}"* واقتراح أقوى الكلمات المفتاحية وزوايا الاستهداف بالذكاء الاصطناعي...`, userId, io);
        
        const stopComposing = startContinuousComposing(sock, remoteJid);
        let result;
        try {
            result = await fetchSuggestedKeywords(niche, 'EG', 1, 0);
        } finally {
            stopComposing();
        }

        if (result.success) {
            session.suggestedKeywords = result.keywords || [];
            session.moreIndex = result.moreIndex;
            session.inSession = true;
        }

        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    // ================================================================
    // Command: /تقرير [رقم الحساب] [الفترة]
    // ================================================================
    if (/^[\/\s]*(تقرير|ads|حملات)($|\s)/i.test(trimmed)) {
        const afterCmd = trimmed.replace(/^[\/\s]*(تقرير|ads|حملات)\s*/i, '').trim();
        const parts = afterCmd.split(/\s+/);
        const accountId = (parts[0] || '').replace(/[^0-9]/g, '');
        const rawPeriod = parts.slice(1).join(' ').trim();
        let period = 'lifetime';

        if (/نهاردة|اليوم|today/i.test(rawPeriod)) period = 'today';
        else if (/امبارح|أمس|yesterday/i.test(rawPeriod)) period = 'yesterday';
        else if (/اسبوع|أسبوع|7/i.test(rawPeriod)) period = 'last_7d';
        else if (/شهر|this_month/i.test(rawPeriod)) period = 'this_month';

        if (!accountId) {
            await replyToStaff(
                sock, 
                remoteJid, 
                '⚠️ يرجى كتابة رقم الحساب الإعلاني بعد الأمر.\nمثال: */تقرير 165453869752274*', 
                userId, 
                io
            );
            return { handled: true };
        }

        await replyToStaff(sock, remoteJid, `⏳ جاري سحب تقرير أداء الحساب الإعلاني (\`${accountId}\`)...`, userId, io);

        const stopComposing = startContinuousComposing(sock, remoteJid);
        let result;
        try {
            result = await fetchCampaignSummary(accountId, period);
        } finally {
            stopComposing();
        }

        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    // ================================================================
    // Command: /حفظ or حفظ or /استخراج or استخراج or CRM
    // ================================================================
    if (/^(\/|\s)*(حفظ|استخراج|crm|سجل|تسجيل|احفظ|استخرج|حفظ\s*في\s*(الـ\s*)?crm|استخراج\s*(الـ\s*)?(ارقام|أرقام|الارقام|الأرقام))($|\s)/i.test(trimmed)) {
        return await saveCompetitorLeadsToCrm({ sock, remoteJid, phoneNumber, userId, io, session });
    }

    // ================================================================
    // Command: /منافسين [الكلمة] or /spy [الكلمة]
    // ================================================================
    if (/^[\/\s]*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق)\s+(.+)$/i.test(trimmed)) {
        let keyword = trimmed.replace(/^[\/\s]*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق)\s+/i, '').trim();
        keyword = keyword.replace(/^(اعلانات|إعلانات|عن|بحث\s*عن)\s+/i, '').trim() || keyword;

        // دعم اختيار الكلمة برقمها إذا سبق طلب كلمات مقترحة (مثال: /منافسين 1 أو /منافسين 4)
        if (/^\d{1,2}$/.test(keyword) && session.suggestedKeywords && session.suggestedKeywords.length > 0) {
            const idx = parseInt(keyword, 10) - 1;
            if (session.suggestedKeywords[idx]) {
                keyword = session.suggestedKeywords[idx];
            }
        }

        session.lastType = 'ads';
        session.lastKeyword = keyword;
        session.currentPage = 1;
        session.adsTotalCount = 0;
        session.inSession = true;

        await replyToStaff(sock, remoteJid, `⏳ جاري فحص مكتبة الإعلانات وسحب إعلانات المنافسين لكلمة *"${keyword}"*...`, userId, io);

        const stopComposing = startContinuousComposing(sock, remoteJid);
        let result;
        try {
            result = await fetchCompetitorAds(keyword, 1, 5, 'EG', 0);
        } finally {
            stopComposing();
        }

        if (result.success) {
            session.currentAds = result.ads || [];
            session.adsMoreIndex = result.moreIndex;
            session.adsSaveIndex = result.saveIndex;
            session.adsTotalCount = result.totalIndex;
        }

        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    // ================================================================
    // In-Session: "المزيد" / "الصفحة اللي بعدها" / "هات 5 كمان"
    // ================================================================
    if (session.inSession && (/^(\/|\s)*(المزيد|more|الصفحة\s*اللي\s*بعدها|هات\s*كمان|هات\s*5\s*كمان|التالي|next)($|\s)/i.test(trimmed))) {
        // إذا كان آخر إجراء هو اقتراح الكلمات والزوايا
        if (session.lastType === 'keywords') {
            if (!session.lastNiche) {
                await replyToStaff(sock, remoteJid, '⚠️ يرجى كتابة المجال المطلوب أولاً. مثال: */كلمات أحذية*', userId, io);
                return { handled: true };
            }

            session.keywordPage = (session.keywordPage || 1) + 1;
            const startIndex = (session.suggestedKeywords || []).length;

            await replyToStaff(sock, remoteJid, `⏳ جاري اقتراح زوايا وكلمات جديدة للدفعة رقم (${session.keywordPage}) لمجال *"${session.lastNiche}"* بالذكاء الاصطناعي...`, userId, io);

            const stopComposing = startContinuousComposing(sock, remoteJid);
            let result;
            try {
                result = await fetchSuggestedKeywords(session.lastNiche, 'EG', session.keywordPage, startIndex);
            } finally {
                stopComposing();
            }

            if (result.success) {
                session.suggestedKeywords = (session.suggestedKeywords || []).concat(result.keywords || []);
                session.moreIndex = result.moreIndex;
            } else {
                session.keywordPage = Math.max(1, session.keywordPage - 1);
            }

            await replyToStaff(sock, remoteJid, result.message, userId, io);
            return { handled: true };
        }

        // إذا كان فحص إعلانات المنافسين
        if (!session.lastKeyword) {
            await replyToStaff(sock, remoteJid, '⚠️ لم يتم البحث عن كلمة بعد! اكتب الكلمة التي تريد البحث عنها أولاً (مثال: ساعات رجالي).', userId, io);
            return { handled: true };
        }

        session.currentPage += 1;
        const startIndex = session.adsTotalCount || ((session.currentPage - 1) * 5);

        await replyToStaff(sock, remoteJid, `⏳ جاري سحب الدفعة رقم (${session.currentPage}) لإعلانات *"${session.lastKeyword}"*...`, userId, io);

        const stopComposing = startContinuousComposing(sock, remoteJid);
        let result;
        try {
            result = await fetchCompetitorAds(session.lastKeyword, session.currentPage, 5, 'EG', startIndex);
        } finally {
            stopComposing();
        }

        if (result.success) {
            session.currentAds = result.ads || [];
            session.adsMoreIndex = result.moreIndex;
            session.adsSaveIndex = result.saveIndex;
            session.adsTotalCount = result.totalIndex;
        } else {
            // Revert page increment if failed
            session.currentPage = Math.max(1, session.currentPage - 1);
        }

        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    // ================================================================
    // In-Session: Any regular text treated intelligently
    // (Skip if user typed Fast Order store commands like /store, /status, etc.)
    // ================================================================
    if (session.inSession && !trimmed.startsWith('/store') && !trimmed.startsWith('/status')) {
        // If it's asking for keywords inside active session
        if (/^(كلمات|اقترح|اقترحلي|عايز\s*كلمات|اقتراح)\b/i.test(trimmed)) {
            let niche = trimmed.replace(/^(كلمات|اقترحلي\s*كلمات|اقترح\s*كلمات|عايز\s*كلمات\s*لـ?|عايز\s*كلمات\s*عن|اقتراح\s*كلمات)\s*/i, '').trim();
            niche = niche.replace(/^(مجال|نشاط|شغال\s*في|ببيع|عن|لـ|في)\s+/i, '').trim() || niche;

            session.lastType = 'keywords';
            session.lastNiche = niche;
            session.keywordPage = 1;

            await replyToStaff(sock, remoteJid, `⏳ جاري تحليل مجال *"${niche}"* واقتراح أقوى الكلمات المفتاحية وزوايا الاستهداف بالذكاء الاصطناعي...`, userId, io);

            const stopComposing = startContinuousComposing(sock, remoteJid);
            let result;
            try {
                result = await fetchSuggestedKeywords(niche, 'EG', 1, 0);
            } finally {
                stopComposing();
            }

            if (result.success) {
                session.suggestedKeywords = result.keywords || [];
                session.moreIndex = result.moreIndex;
            }
            await replyToStaff(sock, remoteJid, result.message, userId, io);
            return { handled: true };
        }

        // إذا قام المستخدم بكتابة رقم (سواء كان رقم خيار المزيد أو رقم استخراج الـ CRM أو رقم إحدى الكلمات)
        if (/^\d{1,2}$/.test(trimmed)) {
            const num = parseInt(trimmed, 10);

            // 1. لو ضغط على رقم "المزيد" المكتوب في نهاية الكلمات المقترحة
            if (session.lastType === 'keywords' && session.moreIndex && num === session.moreIndex) {
                session.keywordPage = (session.keywordPage || 1) + 1;
                const startIndex = (session.suggestedKeywords || []).length;

                await replyToStaff(sock, remoteJid, `⏳ جاري اقتراح زوايا وكلمات جديدة للدفعة رقم (${session.keywordPage}) لمجال *"${session.lastNiche}"* بالذكاء الاصطناعي...`, userId, io);

                const stopComposing = startContinuousComposing(sock, remoteJid);
                let result;
                try {
                    result = await fetchSuggestedKeywords(session.lastNiche, 'EG', session.keywordPage, startIndex);
                } finally {
                    stopComposing();
                }

                if (result.success) {
                    session.suggestedKeywords = (session.suggestedKeywords || []).concat(result.keywords || []);
                    session.moreIndex = result.moreIndex;
                } else {
                    session.keywordPage = Math.max(1, session.keywordPage - 1);
                }

                await replyToStaff(sock, remoteJid, result.message, userId, io);
                return { handled: true };
            }

            // 2. لو ضغط على رقم "المزيد" المكتوب في نهاية إعلانات المنافسين
            if (session.lastType === 'ads' && session.adsMoreIndex && num === session.adsMoreIndex) {
                session.currentPage += 1;
                const startIndex = session.adsTotalCount || ((session.currentPage - 1) * 5);

                await replyToStaff(sock, remoteJid, `⏳ جاري سحب الدفعة رقم (${session.currentPage}) لإعلانات *"${session.lastKeyword}"*...`, userId, io);

                const stopComposing = startContinuousComposing(sock, remoteJid);
                let result;
                try {
                    result = await fetchCompetitorAds(session.lastKeyword, session.currentPage, 5, 'EG', startIndex);
                } finally {
                    stopComposing();
                }

                if (result.success) {
                    session.currentAds = result.ads || [];
                    session.adsMoreIndex = result.moreIndex;
                    session.adsSaveIndex = result.saveIndex;
                    session.adsTotalCount = result.totalIndex;
                } else {
                    session.currentPage = Math.max(1, session.currentPage - 1);
                }

                await replyToStaff(sock, remoteJid, result.message, userId, io);
                return { handled: true };
            }

            // 3. لو ضغط على رقم "استخراج الأرقام وحفظ في الـ CRM"
            if (session.lastType === 'ads' && session.adsSaveIndex && num === session.adsSaveIndex) {
                return await saveCompetitorLeadsToCrm({ sock, remoteJid, phoneNumber, userId, io, session });
            }

            // 4. لو اختار رقم إحدى الكلمات المقترحة لجلب إعلاناتها
            const idx = num - 1;
            if (session.suggestedKeywords && session.suggestedKeywords[idx]) {
                const selectedKeyword = session.suggestedKeywords[idx];
                session.lastType = 'ads';
                session.lastKeyword = selectedKeyword;
                session.currentPage = 1;
                session.adsTotalCount = 0;

                await replyToStaff(sock, remoteJid, `⏳ جاري فحص مكتبة الإعلانات لكلمة *"${selectedKeyword}"*...`, userId, io);

                const stopComposing = startContinuousComposing(sock, remoteJid);
                let result;
                try {
                    result = await fetchCompetitorAds(selectedKeyword, 1, 5, 'EG', 0);
                } finally {
                    stopComposing();
                }

                if (result.success) {
                    session.currentAds = result.ads || [];
                    session.adsMoreIndex = result.moreIndex;
                    session.adsSaveIndex = result.saveIndex;
                    session.adsTotalCount = result.totalIndex;
                }
                await replyToStaff(sock, remoteJid, result.message, userId, io);
                return { handled: true };
            }
        }

        // If it's pure numbers (10+ digits), user might be asking for an ad report
        if (/^\d{10,}$/.test(trimmed)) {
            await replyToStaff(sock, remoteJid, `⏳ جاري سحب تقرير أداء الحساب الإعلاني (\`${trimmed}\`)...`, userId, io);

            const stopComposing = startContinuousComposing(sock, remoteJid);
            let result;
            try {
                result = await fetchCampaignSummary(trimmed, 'lifetime');
            } finally {
                stopComposing();
            }

            await replyToStaff(sock, remoteJid, result.message, userId, io);
            return { handled: true };
        }

        let searchKeyword = trimmed;
        searchKeyword = searchKeyword.replace(/^(اعلانات|إعلانات|عن|بحث\s*عن|هات\s*اعلانات)\s+/i, '').trim() || searchKeyword;

        session.lastType = 'ads';
        session.lastKeyword = searchKeyword;
        session.currentPage = 1;
        session.adsTotalCount = 0;

        await replyToStaff(sock, remoteJid, `⏳ جاري فحص مكتبة الإعلانات لكلمة *"${searchKeyword}"*...`, userId, io);

        const stopComposing = startContinuousComposing(sock, remoteJid);
        let result;
        try {
            result = await fetchCompetitorAds(searchKeyword, 1, 5, 'EG', 0);
        } finally {
            stopComposing();
        }

        if (result.success) {
            session.currentAds = result.ads || [];
            session.adsMoreIndex = result.moreIndex;
            session.adsSaveIndex = result.saveIndex;
            session.adsTotalCount = result.totalIndex;
        }
        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    return { handled: false };
}
