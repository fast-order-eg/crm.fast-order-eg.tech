import fetch from 'node-fetch';
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
    return /^(\/|\s)*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق|كلمات|الكلمات|keywords|نوتش|تقرير|ads|حملات|المزيد|more|خروج|close)($|\s)/i.test(trimmed);
}

/**
 * Send WhatsApp reply to staff AND permanently log it to the SQL Database (messages table)
 */
async function replyToStaff(sock, remoteJid, text, userId, io) {
    if (!sock || !remoteJid || !text) return;

    // 1. Send via WhatsApp socket
    try {
        await sock.sendMessage(remoteJid, { text });
    } catch (sendErr) {
        console.error('❌ [replyToStaff - Competitor] WhatsApp send error:', sendErr.message);
    }

    // 2. Permanently log assistant reply to SQL DB
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
            const roleLabel = u.role === 'super_admin' ? 'مدير عام' :
                              u.role === 'admin' ? 'مدير' : 'مسؤول مبيعات';
            const isActive = !excludedSet.has(cleanP);
            list.push({
                id: u.id,
                name: u.fullName || u.username,
                username: u.username,
                role: u.role,
                roleLabel,
                phone: cleanP,
                isPrimary: false,
                isActive,
                isCustom: false
            });
        }
    }

    // 3. Custom Added Staff
    for (const c of customList) {
        const cleanP = normalizePhone(c.phone);
        if (cleanP && !seenPhones.has(cleanP)) {
            seenPhones.add(cleanP);
            let cleanRoleLabel = (c.roleLabel || 'مسؤول مبيعات').replace(/\s*\(.*?\)/g, '').trim();
            if (!cleanRoleLabel) cleanRoleLabel = 'مسؤول مبيعات';
            const isActive = !excludedSet.has(cleanP);
            list.push({
                id: c.id || `custom_${cleanP}`,
                name: c.name || 'موظف مخصص',
                username: c.username || cleanP,
                role: c.role || 'sales',
                roleLabel: cleanRoleLabel,
                phone: cleanP,
                isPrimary: false,
                isActive,
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
 * Call External API 1: Suggest Keywords (Vertex AI)
 */
export async function fetchSuggestedKeywords(niche, country = 'EG') {
    try {
        const res = await fetch(`${COMPETITOR_API_BASE}/suggest-keywords`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': COMPETITOR_API_KEY
            },
            body: JSON.stringify({ niche, country })
        });

        const data = await res.json().catch(() => null);
        if (data && data.formatted_message) {
            return { success: true, message: data.formatted_message };
        } else if (data && data.error) {
            return { success: false, message: `⚠️ ${data.error}` };
        }
        return { success: false, message: '⚠️ تعذر جلب الكلمات المقترحة حالياً. يرجى المحاولة لاحقاً.' };
    } catch (err) {
        console.error('❌ [fetchSuggestedKeywords] Error:', err.message);
        return { success: false, message: `⚠️ حدث خطأ في الاتصال بالخدمة: ${err.message}` };
    }
}

/**
 * Call External API 2: Competitor Live Ads (Facebook Ad Library with Pagination)
 */
export async function fetchCompetitorAds(keyword, page = 1, limit = 5, country = 'EG') {
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
        if (data && data.formatted_message) {
            return { 
                success: true, 
                message: data.formatted_message,
                total_ads: data.total_ads || 0,
                has_more: data.has_more !== false
            };
        } else if (data && data.error) {
            return { success: false, message: `⚠️ ${data.error}` };
        }
        return { success: false, message: '⚠️ لم يتم العثور على إعلانات كافية لهذه الكلمة حالياً.' };
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
    const keywordsMatch = trimmed.match(/^(\/|\s)*(كلمات|الكلمات|keywords|نوتش)\s*(.*)$/i);
    if (keywordsMatch) {
        const niche = (keywordsMatch[2] || '').trim();
        if (!niche) {
            await replyToStaff(
                sock, 
                remoteJid, 
                '⚠️ يرجى كتابة المجال المطلوب بعد الأمر.\nمثال: */كلمات عبايات خليجي* أو */كلمات أحذية رياضية*', 
                userId, 
                io
            );
            return { handled: true };
        }

        await replyToStaff(sock, remoteJid, `⏳ جاري تحليل مجال *"${niche}"* واقتراح أقوى الكلمات المفتاحية وزوايا الاستهداف بالذكاء الاصطناعي...`, userId, io);
        const result = await fetchSuggestedKeywords(niche);

        let finalMsg = result.message;
        if (result.success) {
            finalMsg += `\n\n💡 *للبحث عن إعلانات أي كلمة من دول:* اكتب */منافسين [الكلمة]*`;
        }
        await replyToStaff(sock, remoteJid, finalMsg, userId, io);
        session.inSession = true;
        return { handled: true };
    }

    // ================================================================
    // Command: /تقرير [رقم الحساب] [الفترة]
    // ================================================================
    const reportMatch = trimmed.match(/^(\/|\s)*(تقرير|ads|حملات)\s*([0-9a-zA-Z_]+)\s*(.*)$/i);
    if (reportMatch) {
        const accountId = reportMatch[2].trim();
        let rawPeriod = (reportMatch[3] || '').trim();
        let period = 'lifetime';

        if (/نهاردة|اليوم|today/i.test(rawPeriod)) period = 'today';
        else if (/امبارح|أمس|yesterday/i.test(rawPeriod)) period = 'yesterday';
        else if (/اسبوع|أسبوع|7/i.test(rawPeriod)) period = 'last_7d';
        else if (/شهر|this_month/i.test(rawPeriod)) period = 'this_month';

        await replyToStaff(sock, remoteJid, `⏳ جاري سحب تقرير أداء الحساب الإعلاني (\`${accountId}\`)...`, userId, io);
        const result = await fetchCampaignSummary(accountId, period);
        await replyToStaff(sock, remoteJid, result.message, userId, io);
        return { handled: true };
    }

    // ================================================================
    // Command: /منافسين [الكلمة] or /spy [الكلمة]
    // ================================================================
    const competitorMatch = trimmed.match(/^(\/|\s)*(منافسين|المنافسين|spy|سوق|عين_السوق|عين\s*السوق)\s+(.+)$/i);
    if (competitorMatch) {
        const keyword = competitorMatch[3].trim();
        session.lastKeyword = keyword;
        session.currentPage = 1;
        session.inSession = true;

        await replyToStaff(sock, remoteJid, `⏳ جاري فحص مكتبة الإعلانات وسحب إعلانات المنافسين لكلمة *"${keyword}"*...`, userId, io);
        const result = await fetchCompetitorAds(keyword, 1, 5);

        let finalMsg = result.message;
        if (result.success) {
            finalMsg += `\n\n📄 *الدفعة 1 (عرض 5 إعلانات)*\n` +
                        `👉 لمشاهدة الـ 5 إعلانات التالية، اكتب: *المزيد* ⏭️\n` +
                        `🔍 للبحث عن كلمة تانية اكتبها فوراً | للخروج: */خروج*`;
        }
        await replyToStaff(sock, remoteJid, finalMsg, userId, io);
        return { handled: true };
    }

    // ================================================================
    // In-Session: "المزيد" / "الصفحة اللي بعدها" / "هات 5 كمان"
    // ================================================================
    if (session.inSession && (/^(\/|\s)*(المزيد|more|الصفحة\s*اللي\s*بعدها|هات\s*كمان|هات\s*5\s*كمان|التالي|next)$/i.test(trimmed))) {
        if (!session.lastKeyword) {
            await replyToStaff(sock, remoteJid, '⚠️ لم يتم البحث عن كلمة بعد! اكتب الكلمة التي تريد البحث عنها أولاً (مثال: ساعات رجالي).', userId, io);
            return { handled: true };
        }

        session.currentPage += 1;
        await replyToStaff(sock, remoteJid, `⏳ جاري سحب الدفعة رقم (${session.currentPage}) لإعلانات *"${session.lastKeyword}"*...`, userId, io);
        const result = await fetchCompetitorAds(session.lastKeyword, session.currentPage, 5);

        let finalMsg = result.message;
        if (result.success) {
            finalMsg += `\n\n📄 *الدفعة ${session.currentPage}*\n` +
                        `👉 لمشاهدة الدفعة التالية، اكتب: *المزيد* ⏭️\n` +
                        `🔍 للبحث عن كلمة تانية اكتبها فوراً | للخروج: */خروج*`;
        } else {
            // Revert page increment if failed
            session.currentPage = Math.max(1, session.currentPage - 1);
        }

        await replyToStaff(sock, remoteJid, finalMsg, userId, io);
        return { handled: true };
    }

    // ================================================================
    // In-Session: Any regular text treated as new competitor keyword search
    // (Skip if user typed Fast Order store commands like /store, /status, etc.)
    // ================================================================
    if (session.inSession && !trimmed.startsWith('/store') && !trimmed.startsWith('/status')) {
        // If it's pure numbers, user might be asking for an ad report
        if (/^\d{10,}$/.test(trimmed)) {
            await replyToStaff(sock, remoteJid, `⏳ جاري سحب تقرير أداء الحساب الإعلاني (\`${trimmed}\`)...`, userId, io);
            const result = await fetchCampaignSummary(trimmed, 'lifetime');
            await replyToStaff(sock, remoteJid, result.message, userId, io);
            return { handled: true };
        }

        session.lastKeyword = trimmed;
        session.currentPage = 1;

        await replyToStaff(sock, remoteJid, `⏳ جاري فحص مكتبة الإعلانات لكلمة *"${trimmed}"*...`, userId, io);
        const result = await fetchCompetitorAds(trimmed, 1, 5);

        let finalMsg = result.message;
        if (result.success) {
            finalMsg += `\n\n📄 *الدفعة 1 (عرض 5 إعلانات)*\n` +
                        `👉 لمشاهدة الـ 5 إعلانات التالية، اكتب: *المزيد* ⏭️\n` +
                        `🔍 للبحث عن كلمة تانية اكتبها فوراً | للخروج: */خروج*`;
        }
        await replyToStaff(sock, remoteJid, finalMsg, userId, io);
        return { handled: true };
    }

    return { handled: false };
}
