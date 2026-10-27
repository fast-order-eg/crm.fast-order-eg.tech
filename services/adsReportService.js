import { getSetting, setSetting } from './settingsService.js';
import { getAuthorizedAdmins, normalizePhoneDigits, PRIMARY_ADMIN } from './reminderService.js';
import { handleCampaignTargetingMessage, isCampaignTargetingCommand, isPlainTargetingCommand } from './campaignTargetingService.js';

const API_ENDPOINT = 'https://einasouq.bird-ads.com/api/v1/merchant/campaigns-summary';
const MANAGE_API_ENDPOINT = 'https://einasouq.bird-ads.com/api/v1/merchant/manage-campaign';
const API_KEY = 'fastorder_merchant_secure_api_key_2026';

/**
 * استدعاء API إدارة الحملات الإعلانية (إيقاف، تشغيل، ميزانية، تمديد، استهداف)
 */
export async function callManageCampaignApi(payload) {
    try {
        const res = await fetch(MANAGE_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            },
            body: JSON.stringify(payload)
        });
        return await res.json();
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * جلب قائمة الأرقام المصرح لها بطلب تقارير الإعلانات
 */
export async function getAdsAuthorizedAdmins(userId = 3) {
    const list = [{
        name: 'أ. راضي',
        phone: PRIMARY_ADMIN.phone,
        roleLabel: 'مدير النظام',
        isPrimary: true
    }];
    const seenDigits = new Set([normalizePhoneDigits(PRIMARY_ADMIN.phone)]);

    try {
        let saved = await getSetting('ads_report_authorized_admins', userId);
        if ((saved === null || saved === undefined) && userId !== 3) {
            saved = await getSetting('ads_report_authorized_admins', 3);
        }
        if ((saved === null || saved === undefined) && userId !== 1) {
            saved = await getSetting('ads_report_authorized_admins', 1);
        }

        let customList = null;
        if (typeof saved === 'string' && saved.trim() !== '') {
            try {
                customList = JSON.parse(saved);
            } catch (_) {}
        } else if (Array.isArray(saved)) {
            customList = saved;
        }

        // إذا لم يتم تخصيص قائمة مستقلة لتقارير الإعلانات بعد، نستورد المشرفين الحاليين من التذكيرات تلقائياً
        if (!Array.isArray(customList)) {
            const fallbackAdmins = await getAuthorizedAdmins(userId);
            customList = fallbackAdmins.filter(a => !a.isPrimary);
        }

        for (const item of customList) {
            if (item && item.phone) {
                const norm = normalizePhoneDigits(item.phone);
                if (norm && !seenDigits.has(norm)) {
                    seenDigits.add(norm);
                    list.push({
                        name: (item.name || '').trim() || 'مسؤول إعلانات',
                        phone: String(item.phone).trim(),
                        roleLabel: item.roleLabel || 'مسؤول إعلانات',
                        isPrimary: false
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error fetching ads authorized admins:', err.message);
    }

    return list;
}

/**
 * إضافة رقم جديد مصرح له بطلب تقارير الإعلانات
 */
export async function addAdsAuthorizedAdmin(rawPhone, adminName = '', userId = 3) {
    let clean = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (clean.startsWith('20') && clean.length === 12) {
        clean = '0' + clean.substring(2);
    } else if (clean.length === 10 && /^(10|11|12|15)/.test(clean)) {
        clean = '0' + clean;
    }

    if (clean.length < 10) {
        return { success: false, message: '⚠️ رقم الهاتف غير صحيح. يرجى إدخال رقم هاتف مصري صالح (مثال: 01012345678).' };
    }

    const cleanNorm = normalizePhoneDigits(clean);
    const currentAdmins = await getAdsAuthorizedAdmins(userId);

    if (currentAdmins.some(a => normalizePhoneDigits(a.phone) === cleanNorm)) {
        const found = currentAdmins.find(a => normalizePhoneDigits(a.phone) === cleanNorm);
        return { success: false, message: `ℹ️ الرقم ${clean} مسجل بالفعل باسم (${found.name}).` };
    }

    const finalName = (adminName || '').trim() || `مسؤول ${clean.slice(-4)}`;
    const customOnly = currentAdmins
        .filter(a => !a.isPrimary && normalizePhoneDigits(a.phone) !== normalizePhoneDigits(PRIMARY_ADMIN.phone))
        .map(a => ({ name: a.name, phone: a.phone, roleLabel: a.roleLabel || 'مسؤول إعلانات', isPrimary: false }));

    customOnly.push({
        name: finalName,
        phone: clean,
        roleLabel: 'مسؤول إعلانات',
        isPrimary: false
    });

    const jsonStr = JSON.stringify(customOnly);
    await setSetting('ads_report_authorized_admins', jsonStr, userId);
    if (userId !== 3) await setSetting('ads_report_authorized_admins', jsonStr, 3);
    if (userId !== 1) await setSetting('ads_report_authorized_admins', jsonStr, 1);

    const updatedList = await getAdsAuthorizedAdmins(userId);
    return {
        success: true,
        message: `✅ تم إضافة الرقم ${clean} (${finalName}) إلى قائمة المصرح لهم بتقارير الإعلانات.`,
        admins: updatedList
    };
}

/**
 * حذف رقم من قائمة المصرح لهم بطلب تقارير الإعلانات
 */
export async function removeAdsAuthorizedAdmin(rawPhone, userId = 3) {
    const cleanNorm = normalizePhoneDigits(rawPhone);
    if (!cleanNorm) {
        return { success: false, message: '⚠️ يرجى تحديد رقم الهاتف المراد حذفه.' };
    }

    if (cleanNorm === normalizePhoneDigits(PRIMARY_ADMIN.phone)) {
        return { success: false, message: '⚠️ لا يمكن حذف رقم الأدمن الأساسي للنظام (أ. راضي).' };
    }

    const currentAdmins = await getAdsAuthorizedAdmins(userId);
    const customOnly = currentAdmins
        .filter(a => !a.isPrimary && normalizePhoneDigits(a.phone) !== cleanNorm)
        .map(a => ({ name: a.name, phone: a.phone, roleLabel: a.roleLabel || 'مسؤول إعلانات', isPrimary: false }));

    const jsonStr = JSON.stringify(customOnly);
    await setSetting('ads_report_authorized_admins', jsonStr, userId);
    if (userId !== 3) await setSetting('ads_report_authorized_admins', jsonStr, 3);
    if (userId !== 1) await setSetting('ads_report_authorized_admins', jsonStr, 1);

    const updatedList = await getAdsAuthorizedAdmins(userId);
    return {
        success: true,
        message: `🗑️ تم إزالة صلاحية الرقم من تقارير الإعلانات بنجاح.`,
        admins: updatedList
    };
}

/**
 * التحقق هل المرسل مصرح له بطلب واستعراض تقارير الإعلانات
 * ملاحظة: جروب تقارير الإعلانات يعتبر جروباً خاصاً ومغلقاً، وجميع المتواجدين فيه مصرح لهم تلقائياً
 */
export async function isAuthorizedAdsAdmin(senderPhone, userId = 3, participantJid = '') {
    return true;
}

/**
 * استخراج الفترة الزمنية المطلوبة من رسالة المستخدم وفق قواعد منصة عين السوق:
 * - الكل / كل الفترات / الإجمالي -> maximum
 * - اليوم -> today
 * - امس / أمس / امبارح -> yesterday
 * - اخر 7 ايام / أسبوع -> last_7d
 * - هذا الشهر -> this_month
 */
export function extractDatePreset(text = '') {
    const t = text.toLowerCase();
    if (t.includes('الكل') || t.includes('كل الفترات') || t.includes('الإجمالي') || t.includes('اجمالي') || t.includes('كل الوقت') || t.includes('maximum') || t.includes('all')) {
        return 'maximum';
    }
    if (t.includes('امبارح') || t.includes('امس') || t.includes('أمس') || t.includes('yesterday')) {
        return 'yesterday';
    }
    if (t.includes('اخر 7') || t.includes('آخر 7') || t.includes('اسبوع') || t.includes('أسبوع') || t.includes('last_7d') || t.includes('7 ايام') || t.includes('7 أيام')) {
        return 'last_7d';
    }
    if (t.includes('الشهر') || t.includes('هذا الشهر') || t.includes('الشهر الحالي') || t.includes('this_month')) {
        return 'this_month';
    }
    if (t.includes('اليوم') || t.includes('today')) {
        return 'today';
    }
    return 'today';
}

/**
 * استخراج فلتر حالة الحملات:
 * - استخدام ACTIVE دائماً لجلب الحملات النشطة والشغالة فقط
 * - إرسال ALL فقط إذا طلب المستخدم صراحة الحملات المتوقفة أو كل الحملات
 */
export function extractStatusFilter(text = '') {
    const t = text.toLowerCase();
    if (
        t.includes('المتوقفة') || t.includes('المتوقفه') || t.includes('متوقف') ||
        t.includes('موقوفة') || t.includes('موقوفه') || t.includes('paused') ||
        t.includes('كل الحملات') || t.includes('جميع الحملات') || t.includes('كل حملات') || t.includes('جميع حملات') || t.includes('الكل') ||
        t.includes('المكتملة') || t.includes('المكتمله') || t.includes('المنتهية') || t.includes('المنتهيه') ||
        t.includes('المرفوضة') || t.includes('المرفوضه') || t.includes('المراجعة') || t.includes('المراجعه')
    ) {
        return 'ALL';
    }
    return 'ACTIVE';
}

/**
 * استخراج معرف الحساب الإعلاني أو الحملة من النص
 */
export function extractAdIdentifiers(text = '') {
    const clean = String(text || '').trim();

    // 1. فحص صيغة act_12345
    const actMatch = clean.match(/act_(\d+)/i);
    if (actMatch) {
        return { type: 'account', id: actMatch[1] };
    }

    // 2. فحص طلبات استعراض حملات الحساب بالعامية (مثال: "اعرضلي الحملات الاعلانية اللي جواه الحساب الاعلاني دا 1234567890")
    const accountBefore = clean.match(/(?:حساب|اكونت|حسابي|account)[^\d]*(\d{6,25})/i);
    if (accountBefore) {
        return { type: 'account', id: accountBefore[1] };
    }
    const accountAfter = clean.match(/(\d{6,25})[^\d]*(?:حساب|اكونت|حسابي|account)/i);
    if (accountAfter) {
        return { type: 'account', id: accountAfter[1] };
    }

    // 3. فحص إذا كان المستخدم حدد صراحة حملة معينة
    const campaignBefore = clean.match(/(?:حملة|حمله|campaign)[^\d]*(\d{10,25})/i);
    if (campaignBefore) {
        return { type: 'campaign', id: campaignBefore[1] };
    }
    const campaignAfter = clean.match(/(\d{10,25})[^\d]*(?:حملة|حمله|campaign)/i);
    if (campaignAfter) {
        return { type: 'campaign', id: campaignAfter[1] };
    }

    // 4. استخراج أول تسلسل أرقام مكون من 6 إلى 25 رقم
    const generalDigits = clean.match(/\b(\d{6,25})\b/);
    if (generalDigits) {
        return { type: 'unknown', id: generalDigits[1] };
    }

    return null;
}

/**
 * تصنيف نوع وهدف الحملة الإعلانية وتوضيح نوع الرسائل (واتساب / ماسنجر / إنستجرام دايركت) بدون إيموجي
 */
export function classifyObjective(objective = '', ctaType = '', camp = null) {
    const obj = String(objective || '').toUpperCase();
    const cta = String(ctaType || '').toUpperCase();

    // فحص ما إذا كان الإعلان مخصصاً لإنستغرام
    const postUrl = String(camp?.post_url || camp?.primary_ad?.post_url || camp?.instagram_url || '');
    const isInstagramUrl = postUrl.includes('instagram.com');
    const isInstagramPlatform = Boolean(
        camp?.platform === 'INSTAGRAM' ||
        camp?.primary_ad?.platform === 'INSTAGRAM' ||
        isInstagramUrl ||
        (camp?.instagram_url && !camp?.facebook_url) ||
        (Array.isArray(camp?.publisher_platforms) && camp.publisher_platforms.length === 1 && camp.publisher_platforms[0] === 'instagram') ||
        camp?.adsets?.some(a => {
            const pubs = a.targeting?.publisher_platforms || a.publisher_platforms;
            return Array.isArray(pubs) && pubs.length === 1 && pubs[0] === 'instagram';
        })
    );

    const destType = String(
        camp?.destination_type || 
        camp?.adsets?.[0]?.destination_type || 
        ''
    ).toUpperCase();

    const isInstagramDirect = Boolean(
        cta === 'INSTAGRAM_MESSAGE' ||
        destType.includes('INSTAGRAM') ||
        (isInstagramPlatform && cta !== 'WHATSAPP_MESSAGE' && (cta === 'MESSAGE_PAGE' || destType.includes('MESSAG') || !cta))
    );

    if (obj.includes('MESSAGES') || obj.includes('ENGAGEMENT') || obj.includes('CONVERSATION') || destType.includes('MESSAG') || cta.includes('MESSAGE')) {
        if (cta === 'WHATSAPP_MESSAGE') {
            return 'إعلان رسائل واتساب';
        }
        if (isInstagramDirect || (isInstagramPlatform && cta !== 'WHATSAPP_MESSAGE')) {
            return 'إعلان رسائل إنستجرام دايركت';
        }
        if (cta === 'MESSAGE_PAGE') {
            return 'إعلان رسائل ماسنجر';
        }
        return isInstagramPlatform ? 'إعلان رسائل إنستجرام دايركت' : 'إعلان رسائل';
    }

    if (obj.includes('SALES') || obj.includes('PURCHASE')) {
        return 'إعلان مبيعات';
    } else if (obj.includes('LEAD')) {
        return 'إعلان تجميع بيانات';
    } else if (obj.includes('TRAFFIC')) {
        return 'إعلان زيارات';
    }
    return 'إعلان ممول';
}

/**
 * استخراج تاريخ وساعة الانتهاء وحساب المدة المتبقية بتوقيت القاهرة كلٌ في سطر منفصل
 */
export function getStopTimeDetails(stopTimeStr) {
    if (!stopTimeStr) {
        return {
            endDate: 'مستمر (بدون تاريخ انتهاء ♾️)',
            remainingText: null
        };
    }
    const stopDate = new Date(stopTimeStr);
    if (isNaN(stopDate.getTime())) return null;

    const now = new Date();
    const diffMs = stopDate.getTime() - now.getTime();

    const monthsArabic = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    
    // جلب أجزاء التاريخ بتوقيت القاهرة
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true
    }).formatToParts(stopDate);

    const getPart = (type) => parts.find(p => p.type === type)?.value;
    const day = getPart('day');
    const monthIdx = parseInt(getPart('month'), 10) - 1;
    const year = getPart('year');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const dayPeriod = getPart('dayPeriod') === 'PM' ? 'م' : 'ص';

    const formattedDate = `${day} ${monthsArabic[monthIdx]} ${year} - الساعة ${hour}:${minute} ${dayPeriod}`;

    if (diffMs <= 0) {
        return {
            endDate: `${formattedDate} (منتهي ⏹️)`,
            remainingText: null
        };
    }

    const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;

    let remainingText = '';
    if (days > 0 && remainingHours > 0) {
        remainingText = `متبقي ${days} يوم و ${remainingHours} ساعة`;
    } else if (days > 0) {
        remainingText = `متبقي ${days} يوم`;
    } else if (remainingHours > 0) {
        remainingText = `متبقي ${remainingHours} ساعة`;
    } else {
        const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
        remainingText = `متبقي ${mins} دقيقة`;
    }

    return {
        endDate: formattedDate,
        remainingText: remainingText
    };
}

/**
 * فحص هل الحملة شغالة ونشطة حالياً أو في المراجعة/التحضير/مرفوضة وتحتاج متابعة التاجر
 * (تستبعد الحملات المؤرشفة، المحذوفة، المتوقفة يدوياً، أو المنتهية/المكتملة)
 */
export function isCampaignCurrentlyRunning(camp) {
    if (!camp) return false;
    const status = String(camp.status || '').toUpperCase();
    const effStatus = String(camp.effective_status || '').toUpperCase();

    // استبعاد المؤرشفة أو المحذوفة
    if (status === 'ARCHIVED' || status === 'DELETED' || effStatus === 'ARCHIVED' || effStatus === 'DELETED') {
        return false;
    }

    // استبعاد المتوقفة يدوياً
    if (status === 'PAUSED' || effStatus === 'PAUSED' || effStatus === 'CAMPAIGN_PAUSED') {
        return false;
    }

    // إذا كانت الحملة مكتملة أو انتهت فترتها الزمنية
    if (camp.is_completed) return false;
    if (camp.stop_time) {
        const stopMs = new Date(camp.stop_time).getTime();
        if (!isNaN(stopMs) && stopMs <= Date.now()) {
            return false;
        }
    }

    // إذا كانت الحملة نشطة، أو قيد المراجعة، أو في التحضير، أو تم رفض إعلانها، أو بها مشاكل
    const relevantStatuses = ['ACTIVE', 'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'DISAPPROVED'];
    if (relevantStatuses.includes(effStatus) || relevantStatuses.includes(status)) {
        return true;
    }

    return status === 'ACTIVE';
}

/**
 * استخراج وصياغة رابط المنشور الأساسي للحملة وفق المنصة الأصلية المعتمدة في API عين السوق:
 * - إذا كان المنشور الأساسي فيسبوك -> عرض رابط فيسبوك فقط
 * - إذا كان المنشور الأساسي إنستغرام -> عرض رابط إنستغرام فقط
 * ⛔ التزاماً بالقاعدة: عدم دمج الرابطين لعدم تشتيت التاجر، والاعتماد التام على المنشور الأساسي post_url
 */
export function formatCampaignPostLinks(camp) {
    if (!camp) return '';

    const fbUrl = (camp.facebook_url || camp.primary_ad?.facebook_url || '').trim();
    const instaUrl = (camp.instagram_url || camp.primary_ad?.instagram_url || '').trim();
    const isHttp = (u) => typeof u === 'string' && u.startsWith('http');

    let out = '';
    if (isHttp(fbUrl)) {
        out += `• 🔗 رابط المنشور (فيسبوك): ${fbUrl}\n`;
    }
    if (isHttp(instaUrl) && instaUrl !== fbUrl) {
        out += `• 🔗 رابط المنشور (إنستغرام): ${instaUrl}\n`;
    }
    if (out) return out;

    const postUrl = (camp.post_url || camp.primary_ad?.post_url || '').trim();
    if (!isHttp(postUrl)) return '';

    const pLabel = String(camp.platform_label || camp.primary_ad?.platform_label || camp.platform || camp.primary_ad?.platform || '').toLowerCase();
    const urlLabel = String(camp.post_url_label || camp.primary_ad?.post_url_label || '');

    let platform = '';
    if (pLabel.includes('فيسبوك') || pLabel.includes('facebook') || urlLabel.includes('فيسبوك') || postUrl.includes('facebook.com')) {
        platform = 'فيسبوك';
    } else if (pLabel.includes('إنستغرام') || pLabel.includes('إنستجرام') || pLabel.includes('instagram') || urlLabel.includes('إنستغرام') || urlLabel.includes('إنستجرام') || postUrl.includes('instagram.com')) {
        platform = 'إنستغرام';
    }

    if (platform === 'فيسبوك') {
        return `• 🔗 رابط المنشور (فيسبوك): ${postUrl}\n`;
    } else if (platform === 'إنستغرام') {
        return `• 🔗 رابط المنشور (إنستغرام): ${postUrl}\n`;
    } else if (urlLabel) {
        return `• 🔗 ${urlLabel}: ${postUrl}\n`;
    } else {
        return `• 🔗 رابط المنشور: ${postUrl}\n`;
    }
}

/**
 * دالة مساعدة للحصول على رابط المنشور الفردي
 */
export function getCampaignPostLink(camp) {
    if (!camp) return null;
    const postUrl = camp.post_url || camp.primary_ad?.post_url || '';
    if (!postUrl || typeof postUrl !== 'string') return null;

    const pLabel = String(camp.platform_label || camp.primary_ad?.platform_label || camp.platform || camp.primary_ad?.platform || '').toLowerCase();
    const urlLabel = String(camp.post_url_label || camp.primary_ad?.post_url_label || '');

    let platform = '';
    if (pLabel.includes('إنستغرام') || pLabel.includes('إنستجرام') || pLabel.includes('instagram') || urlLabel.includes('إنستغرام') || urlLabel.includes('إنستجرام') || postUrl.includes('instagram.com')) {
        platform = 'إنستغرام';
    } else if (pLabel.includes('فيسبوك') || pLabel.includes('facebook') || urlLabel.includes('فيسبوك') || postUrl.includes('facebook.com')) {
        platform = 'فيسبوك';
    } else {
        platform = camp.platform_label || 'منشور';
    }

    return {
        url: postUrl.trim(),
        platform: platform,
        label: urlLabel || `رابط المنشور (${platform})`
    };
}

/**
 * تنسيق ميزانية الحملة وتحديد هل هي يومية أم إجمالية بعلامة ج
 */
export function formatCampaignBudget(camp) {
    if (!camp) return '';
    const bAmount = Math.round(Number(camp.budget || camp.daily_budget || camp.lifetime_budget || 0));
    if (bAmount <= 0) return '';
    const bType = (camp.budget_type === 'DAILY' || camp.daily_budget)
        ? 'يومي'
        : (camp.budget_type === 'LIFETIME' || camp.lifetime_budget)
            ? 'إجمالي'
            : '';
    return `${bAmount.toLocaleString('en-US')}ج${bType ? ` (${bType})` : ''}`;
}

/**
 * استدعاء API منصة einasouq.bird-ads.com لجلب نتائج وأداء الحملات:
 * 1. إرسال status_filter: "ACTIVE" دائماً لجلب الحملات النشطة والشغالة فقط.
 * 2. إرسال force_refresh: true دائماً لجلب أحدث البيانات اللحظية.
 * 3. آلية إعادة محاولة تلقائية (Auto-Retry) حتى 3 مرات مع مهلة 15 ثانية لمقاومة انقطاع الشبكة اللحظي.
 */
export async function fetchCampaignsSummary({
    account_id,
    campaign_ids,
    date_preset = 'today',
    status_filter = 'ACTIVE',
    force_refresh = true
}) {
    const payload = {
        date_preset,
        status_filter: status_filter || 'ACTIVE',
        force_refresh: force_refresh !== undefined ? force_refresh : true
    };
    if (account_id) payload.account_id = String(account_id).trim();
    if (campaign_ids && Array.isArray(campaign_ids) && campaign_ids.length > 0) {
        payload.campaign_ids = campaign_ids.map(id => String(id).trim());
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': API_KEY
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const text = await response.text();
                try {
                    const jsonErr = JSON.parse(text);
                    return jsonErr;
                } catch (_) {
                    throw new Error(`HTTP ${response.status}: ${text.slice(0, 100)}`);
                }
            }

            const data = await response.json();
            return data;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ [Ads API] Attempt ${attempt} failed for payload:`, payload, err.message);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 800 * attempt));
            }
        }
    }

    console.error('Error fetching campaigns summary from bird-ads API after 3 attempts:', lastError);
    return { success: false, error: lastError?.message || 'تعذر الاتصال بخادم الإعلانات بعد 3 محاولات.' };
}

/**
 * صياغة رد الواتساب الاحترافي وفق التعليمات:
/**
 * تنسيق تقرير حملة إعلانية مخصص للعميل مباشرة:
 * 1. حذف رصيد الحساب المتاح نهائياً.
 * 2. حذف المعرف واسم الحساب من أعلى الرسالة.
 * 3. حذف تعليمات تغيير الفترة من الأسفل.
 * 4. عدم كتابة الفترة في الأعلى، وتضمين تقرير اليوم وتحته تقرير أمس.
 * 5. عدم تكرار معرف الحملة إطلاقاً في الرسالة.
 */
export function formatCampaignAdsReportMessage(todayData, yesterdayData, requestedId = '') {
    const todayCampaigns = todayData?.campaigns || [];
    const yesterdayCampaigns = yesterdayData?.campaigns || [];

    // دمج معرفات الحملات بدون تكرار
    const allCampaignIds = Array.from(new Set([
        ...todayCampaigns.map(c => c.id),
        ...yesterdayCampaigns.map(c => c.id)
    ]));

    if (allCampaignIds.length === 0) {
        return `ℹ️ لم يتم العثور على بيانات لهذه الحملة الإعلانية (المعرف: ${requestedId}).`;
    }

    let msg = `📊 *تقرير أداء الإعلانات الممولة*\n══════════════\n`;

    allCampaignIds.forEach((campId, idx) => {
        const todayCamp = todayCampaigns.find(c => c.id === campId);
        const yestCamp = yesterdayCampaigns.find(c => c.id === campId);
        const camp = todayCamp || yestCamp;

        // 1. البيانات العامة للحملة (تظهر مرة واحدة فقط)
        const cStatus = camp.status_label || (camp.status === 'ACTIVE' ? '🟢 نشطة' : '⏸️ متوقفة');
        const ctaType = camp.ads?.[0]?.creative?.cta_type || camp.primary_ad?.cta_type || '';
        const cObj = classifyObjective(camp.objective, ctaType, camp);
        const budgetStr = formatCampaignBudget(camp);
        const stopInfo = getStopTimeDetails(camp.stop_time);
        const linksText = formatCampaignPostLinks(camp);

        const numPrefix = allCampaignIds.length > 1 ? `${idx + 1}️⃣ ` : '📌 ';
        msg += `${numPrefix}*${camp.name || 'حملة بدون اسم'}*\n`;
        msg += `• معرف الحملة: \`${camp.id}\`\n`;
        msg += `• الحالة: ${cStatus}\n`;
        const rejReason = camp.disapproval_reason || camp.primary_ad?.disapproval_reason;
        if (rejReason) {
            msg += `• ⚠️ سبب الرفض: *${rejReason}*\n`;
        }
        const issSummary = camp.issue_summary || camp.primary_ad?.issue_summary;
        if (issSummary) {
            msg += `• ⚠️ تفاصيل المشكلة: *${issSummary}*\n`;
        }
        msg += `• النوع: *${cObj}*\n`;
        if (budgetStr) {
            msg += `• 💵 الميزانية: *${budgetStr}*\n`;
        }
        if (stopInfo?.endDate) {
            msg += `• ⏳ الانتهاء: ${stopInfo.endDate}\n`;
        }
        if (stopInfo?.remainingText) {
            msg += `• ⏳ المتبقي: ${stopInfo.remainingText}\n`;
        }
        if (linksText) {
            msg += linksText;
        }

        msg += `══════════════\n`;

        // 2. تقرير اليوم
        if (todayCamp) {
            const tSpend = Math.round(Number(todayCamp.spend || 0)).toLocaleString('en-US');
            const tResults = Number(todayCamp.results || 0).toLocaleString('en-US');
            const tLabel = todayCamp.result_label || 'رسائل';
            const tCpa = Number(todayCamp.cpa || 0).toFixed(2);
            const tRoas = todayCamp.roas ? Number(todayCamp.roas).toFixed(1) : null;
            const tCtr = Number(todayCamp.ctr || 0).toFixed(2);
            const tReach = todayCamp.reach ? Number(todayCamp.reach).toLocaleString('en-US') : null;

            msg += `📅 *تقرير اليوم:*\n`;
            msg += `• 💸 المصروف: *${tSpend}ج*\n`;
            msg += `• 🎯 النتائج: *${tResults}* ${tLabel}\n`;
            msg += `• 🏷️ تكلفة النتيجة: *${tCpa}ج*\n`;
            if (tReach) {
                msg += `• 👥 عدد الوصول: *${tReach}*\n`;
            }
            msg += `• 👆 معدل النقر (CTR): *${tCtr}%*\n`;
            if (tRoas && Number(tRoas) > 0) {
                msg += `• 📈 العائد (ROAS): *${tRoas}*\n`;
            }
        } else {
            msg += `📅 *تقرير اليوم:*\n`;
            msg += `• 💸 المصروف: *0ج*\n`;
            msg += `• 🎯 النتائج: *0*\n`;
            msg += `• 🏷️ تكلفة النتيجة: *0ج*\n`;
            msg += `• 👆 معدل النقر (CTR): *0%*\n`;
        }

        msg += `\n`;

        // 3. تقرير أمس
        if (yestCamp) {
            const ySpend = Math.round(Number(yestCamp.spend || 0)).toLocaleString('en-US');
            const yResults = Number(yestCamp.results || 0).toLocaleString('en-US');
            const yLabel = yestCamp.result_label || 'رسائل';
            const yCpa = Number(yestCamp.cpa || 0).toFixed(2);
            const yRoas = yestCamp.roas ? Number(yestCamp.roas).toFixed(1) : null;
            const yCtr = Number(yestCamp.ctr || 0).toFixed(2);
            const yReach = yestCamp.reach ? Number(yestCamp.reach).toLocaleString('en-US') : null;

            msg += `📅 *تقرير أمس:*\n`;
            msg += `• 💸 المصروف: *${ySpend}ج*\n`;
            msg += `• 🎯 النتائج: *${yResults}* ${yLabel}\n`;
            msg += `• 🏷️ تكلفة النتيجة: *${yCpa}ج*\n`;
            if (yReach) {
                msg += `• 👥 عدد الوصول: *${yReach}*\n`;
            }
            msg += `• 👆 معدل النقر (CTR): *${yCtr}%*\n`;
            if (yRoas && Number(yRoas) > 0) {
                msg += `• 📈 العائد (ROAS): *${yRoas}*\n`;
            }
        } else {
            msg += `📅 *تقرير أمس:*\n`;
            msg += `• 💸 المصروف: *0ج*\n`;
            msg += `• 🎯 النتائج: *0*\n`;
            msg += `• 🏷️ تكلفة النتيجة: *0ج*\n`;
            msg += `• 👆 معدل النقر (CTR): *0%*\n`;
        }

        if (allCampaignIds.length === 1) {
            msg += `\n💡 *أوامر سريعة للتحكم:* \`وقف ${camp.id}\` | \`شغل ${camp.id}\` | \`ميزانية ${camp.id} 500\` | \`تمديد ${camp.id} 3 ايام\`\n`;
        }

        if (idx < allCampaignIds.length - 1) {
            msg += `\n══════════════\n`;
        }
    });

    return msg.trim();
}

/**
 * 1. عرض الحملات النشطة والشغالة فقط.
 * 2. الحالة نشطة بدون كلمة ACTIVE.
 * 3. فواصل قصيرة مناسبة لشاشات الموبايل (══════════════).
 * 4. نوع الرسائل واضح (رسائل واتساب / ماسنجر) بدون إيموجي.
 * 5. إظهار معرف الحملة الإعلانية.
 * 6. إظهار الميزانية ونوعها (يومي / إجمالي) والمصروف والتكلفة بعلامة ج.
 * 7. حذف كلمة CPA والاكتفاء بـ "تكلفة النتيجة: Xج".
 * 8. تاريخ الانتهاء على سطر والمدة المتبقية على سطر منفصل.
 * 9. حذف "مرات الظهور" وحذف ملخص "الحملات النشطة".
 * 10. عدم وضع روابط تخمينية.
 */
export function formatAdsReportMessage(data, requestedId = '', datePreset = 'today', isExplicitCampaign = false, statusFilter = 'ACTIVE', yesterdayData = null) {
    if (isExplicitCampaign) {
        return formatCampaignAdsReportMessage(data, yesterdayData, requestedId);
    }

    const presetLabels = {
        today: 'اليوم',
        yesterday: 'أمس',
        last_7d: 'آخر 7 أيام',
        this_month: 'هذا الشهر',
        maximum: 'كل الفترات (الإجمالي)'
    };
    const periodLabel = presetLabels[datePreset] || datePreset;

    const rawCampaigns = data.campaigns || [];

    // تصفية الحملات:
    // إذا كان الاستعلام عن حملة محددة أو طلب المستخدم الحملات المتوقفة صراحة (statusFilter === 'ALL') نعرض كل ما رجع
    // وإلا نعرض الحملات النشطة والشغالة فقط
    const campaigns = (isExplicitCampaign || statusFilter === 'ALL')
        ? rawCampaigns
        : rawCampaigns.filter(isCampaignCurrentlyRunning);

    // استخراج اسم الحساب الإعلاني ورصيد الحساب المتاح إن وجد
    const accountName = data.summary?.account_name || data.account?.name || data.campaigns?.[0]?.account_name || '';
    const balanceVal = data.summary?.account_balance ?? data.account?.balance ?? data.campaigns?.[0]?.account_balance;

    let balanceStr = '';
    if (balanceVal !== undefined && balanceVal !== null && balanceVal !== '') {
        const num = Number(balanceVal);
        if (!isNaN(num)) {
            balanceStr = `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
        } else {
            balanceStr = `${balanceVal}`;
            if (!balanceStr.includes('ج') && !balanceStr.includes('EGP')) {
                balanceStr += ' ج.م';
            }
        }
    } else if (data.summary?.account_balance_formatted) {
        balanceStr = data.summary.account_balance_formatted.replace(/EGP/gi, 'ج.م').trim();
    }

    let msg = `📊 *تقرير أداء الإعلانات الممولة*\n`;
    if (requestedId) {
        msg += `🔢 *المعرف:* \`${requestedId}\`${accountName ? ` (${accountName})` : ''}\n`;
    } else if (accountName) {
        msg += `🏢 *اسم الحساب:* ${accountName}\n`;
    }

    if (balanceStr) {
        msg += `💳 *رصيد الحساب المتاح:* ${balanceStr}\n`;
    }

    msg += `📅 *الفترة:* ${periodLabel}\n`;
    msg += `══════════════\n`;

    if (campaigns.length === 0) {
        msg += `ℹ️ لا توجد حالياً أي حملات إعلانية نشطة أو شغالة في هذا الحساب (جميع الحملات متوقفة أو انتهت فترتها).\n\n`;
        msg += `💡 *لتغيير الفترة:* اكتب رقم الحساب مع: "اليوم" أو "امس" أو "اخر 7 ايام" أو "هذا الشهر" أو "الكل".`;
        return msg;
    }

    campaigns.forEach((camp, idx) => {
        // 1. قراءة الحالة من campaign.status_label المباشرة من الـ API
        const cStatus = camp.status_label || (camp.status === 'ACTIVE' ? '🟢 نشطة' : '⏸️ متوقفة');
        const ctaType = camp.ads?.[0]?.creative?.cta_type || camp.primary_ad?.cta_type || '';
        const cObj = classifyObjective(camp.objective, ctaType, camp);
        const cSpend = Math.round(Number(camp.spend || 0)).toLocaleString('en-US');
        const cResults = Number(camp.results || 0).toLocaleString('en-US');
        const cLabel = camp.result_label || 'نتائج';
        const cCpa = Number(camp.cpa || 0).toFixed(2);
        const cRoas = camp.roas ? Number(camp.roas).toFixed(1) : null;
        const cCtr = Number(camp.ctr || 0).toFixed(2);
        const cReach = camp.reach ? Number(camp.reach).toLocaleString('en-US') : null;
        const stopInfo = getStopTimeDetails(camp.stop_time);
        const budgetStr = formatCampaignBudget(camp);

        const numPrefix = campaigns.length > 1 ? `${idx + 1}️⃣ ` : '📌 ';
        msg += `${numPrefix}*${camp.name || 'حملة بدون اسم'}*\n`;
        msg += `• معرف الحملة: \`${camp.id}\`\n`;
        msg += `• الحالة: ${cStatus}\n`;
        const rejReason = camp.disapproval_reason || camp.primary_ad?.disapproval_reason;
        if (rejReason) {
            msg += `• ⚠️ سبب الرفض: *${rejReason}*\n`;
        }
        const issSummary = camp.issue_summary || camp.primary_ad?.issue_summary;
        if (issSummary) {
            msg += `• ⚠️ تفاصيل المشكلة: *${issSummary}*\n`;
        }
        msg += `• النوع: *${cObj}*\n`;
        if (budgetStr) {
            msg += `• 💵 الميزانية: *${budgetStr}*\n`;
        }
        msg += `• 💸 المصروف: *${cSpend}ج*\n`;
        msg += `• 🎯 النتائج: *${cResults}* ${cLabel}\n`;
        msg += `• 🏷️ تكلفة النتيجة: *${cCpa}ج*\n`;
        if (cRoas && Number(cRoas) > 0) {
            msg += `• 📈 العائد (ROAS): *${cRoas}*\n`;
        }
        if (cReach) {
            msg += `• 👥 عدد الوصول: *${cReach}*\n`;
        }
        msg += `• 👆 معدل النقر (CTR): *${cCtr}%*\n`;
        if (stopInfo?.endDate) {
            msg += `• ⏳ الانتهاء: ${stopInfo.endDate}\n`;
        }
        if (stopInfo?.remainingText) {
            msg += `• ⏳ المتبقي: ${stopInfo.remainingText}\n`;
        }

        // 2. قراءة وصياغة روابط المنشورات (فيسبوك وإنستغرام) وفق القواعد المعتمدة
        const linksText = formatCampaignPostLinks(camp);
        if (linksText) {
            msg += linksText;
        }

        msg += `\n`;
    });

    msg += `══════════════\n`;
    msg += `💡 *لتغيير الفترة:* اكتب رقم الحساب مع: "اليوم" أو "امس" أو "اخر 7 ايام" أو "هذا الشهر" أو "الكل".\n\n`;
    msg += `💡 *للتحكم في أي حملة، قولي بالعامية مباشرة:*\n`;
    msg += `• "الحملة [الرقم] وقفها" ⏸️\n`;
    msg += `• "شغل الحملة [الرقم]" 🟢\n`;
    msg += `• "ميزانية الحملة [الرقم] خليها 500" 💵\n`;
    msg += `• "مد الحملة [الرقم] 3 أيام" ⏳\n`;
    msg += `• "استهداف [الرقم]" لتدقيق الاستهداف بالذكاء الاصطناعي 🎯`;

    return msg;
}

/**
 * إرسال رسالة في الجروب مع محاكاة بشرية دقيقة وشاملة لحماية الحساب من الحظر (Anti-Ban)
 */
async function sendGroupReply(sock, remoteJid, content) {
    const rawText = content.text || '';
    const textLen = rawText.length;

    // 🛡️ معايير الأمان المتقدمة للحماية من الحظر (Anti-Ban Protection):
    // 1. الإعلان عن التواجد (available) أولاً
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // 2. محاكاة كتابة بشرية واقعية تتناسب مع طول محتوى التقرير (بين 3.5 إلى 6.5 ثانية)
    const typingDuration = Math.min(6500, Math.max(3000, Math.floor(textLen * 8) + Math.floor(Math.random() * 1800)));

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            console.log(`✍️ [Ads Anti-Ban] Simulating human typing for ${(typingDuration / 1000).toFixed(1)}s in group...`);
            await new Promise(r => setTimeout(r, typingDuration));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // 3. إضافة مسافة فارغة غير مرئية عشوائية (Zero-Width Space) لكسر بصمة الرسالة وتجنب تكرار الـ Hash لدى خوارزميات ميتا
    const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    const randomJitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
    if (content.text) {
        content.text = `${content.text}${randomJitter}`;
    }

    // 4. إرسال الرسالة
    const res = await sock.sendMessage(remoteJid, content);

    // 5. ضبط الحالة على غير متواجد (unavailable) بعد مهلة قصيرة لمحاكاة السلوك البشري
    setTimeout(() => {
        try {
            if (typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('unavailable', remoteJid).catch(() => {});
            }
        } catch (_) {}
    }, 2000);

    return res;
}

/**
 * تحليل ذكي لأوامر إدارة الحملات بالعامية المصرية الطبيعية وكأنك تخاطب ميديا باير
 * يدعم جميع الصيغ المباشرة والعامية الحرة بأي ترتيب
 */
export function parseConversationalCampaignCommand(rawText = '') {
    if (!rawText || typeof rawText !== 'string') return null;
    const text = rawText.trim().replace(/^\//, '');

    const idMatches = text.match(/\b\d{10,25}\b/g);
    if (!idMatches || idMatches.length === 0) {
        return null;
    }

    const campaignId = idMatches[0];

    // استبعاد استفسارات فحص وتدقيق الاستهداف بالذكاء الاصطناعي (عين السوق)
    if (/(?:^|\s)استهداف(?:\s|$)/i.test(text) && !/(?:سن|نوع|مناطق|اهتمامات)/i.test(text)) {
        return null;
    }

    // استبعاد طلبات التقارير الصريحة بدون أي فعل تحكم (مثال: "تقرير الحملة 123"، "اعرضلي الحملة 123")
    if (/^(?:تقرير|اداء|أداء|نتائج|اعرضلي|وريني|هاتلي)\s*(?:حملة|حمله|الاعلان)?\s*\d{10,25}(?:\s*(?:اليوم|امس|امبارح|اخر 7 ايام|هذا الشهر|الكل))?$/i.test(text)) {
        return null;
    }

    // 1. أمر إيقاف الحملة (Pause)
    if (/(?:^|\s|\/)(?:وقف|وقفه|وقفي|وقفها|وقفلي|وقفوا|توقف|توقفي|توقفلي|ايقاف|إيقاف|توقيف|عطل|عطلها|pause|stop)(?:\s|$|[^\w\d])/i.test(text)) {
        if (!/(?:ليه|هو ليه|ازاي|سبب|الحملات المتوقفة|الحملات المتوقفه)/i.test(text)) {
            return {
                action: 'UPDATE_STATUS',
                campaignId,
                status: 'PAUSED'
            };
        }
    }

    // 2. أمر تشغيل الحملة (Resume / Active)
    if (/(?:^|\s|\/)(?:شغل|شغله|شغلي|شغلها|شغلوا|تشغيل|تشغلي|تشغل|فعل|فعلها|فعلي|تفعيل|resume|start|active)(?:\s|$|[^\w\d])/i.test(text)) {
        if (!/(?:ليه|هو ليه|ازاي|سبب|الحملات الشغالة|الحملات الشغاله|الحملات النشطة|الحملات النشطه)/i.test(text)) {
            return {
                action: 'UPDATE_STATUS',
                campaignId,
                status: 'ACTIVE'
            };
        }
    }

    // 3. أمر تعديل الميزانية (Budget)
    if (/(?:ميزان|ميزانية|ميزانيه|budget|صرف|فلوس)/i.test(text)) {
        const allNums = text.match(/\b\d+(?:\.\d+)?\b/g) || [];
        const budgetNumStr = allNums.find(n => n !== campaignId && Number(n) >= 10 && Number(n) <= 500000);
        if (budgetNumStr) {
            const isLifetime = /(كلي|إجمالي|اجمالي|إجمالية|اجمالية|lifetime)/i.test(text);
            return {
                action: 'UPDATE_BUDGET',
                campaignId,
                amount: budgetNumStr,
                isLifetime
            };
        }
    }

    // 4. أمر تمديد الحملة (Extend)
    if (/(?:تمديد|مد|مدلي|مدها|طول|طولها|طولي|زود مدة|زودلي|زود|extend)/i.test(text) && !/(?:ميزان|ميزانية|ميزانيه|فلوس)/i.test(text)) {
        let days = null;
        if (/(?:اسبوعين|أسبوعين)/i.test(text)) days = 14;
        else if (/(?:اسبوع|أسبوع)/i.test(text)) days = 7;
        else if (/(?:شهر)/i.test(text)) days = 30;
        else if (/(?:يومين)/i.test(text)) days = 2;
        else if (/(?:يوم واحد|يوم(?:\s|$))/i.test(text) && !/\d+\s*يوم/.test(text)) days = 1;
        else {
            const allNums = text.match(/\b\d+\b/g) || [];
            const dayNumStr = allNums.find(n => n !== campaignId && Number(n) >= 1 && Number(n) <= 365);
            if (dayNumStr) days = parseInt(dayNumStr, 10);
        }

        if (days) {
            return {
                action: 'UPDATE_STOP_TIME',
                campaignId,
                extendDays: days
            };
        }
    }

    // 5. بدون تاريخ انتهاء
    if (/(?:بدون انتهاء|حذف انتهاء|شيل الانتهاء|مستمرة|مستمره|بدون تاريخ انتهاء|شيل تاريخ الانتهاء)/i.test(text)) {
        return {
            action: 'UPDATE_STOP_TIME',
            campaignId,
            stopTime: 'never'
        };
    }

    // 6. تاريخ انتهاء محدد
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/);
    if (dateMatch && /(?:انتهاء|انهاء|تاريخ انتهاء|نهاية)/i.test(text)) {
        return {
            action: 'UPDATE_STOP_TIME',
            campaignId,
            stopTime: dateMatch[1]
        };
    }

    // 7. تعديل السن
    if (/(?:سن|عمر|السن|العمر|age)/i.test(text)) {
        const ageMatch = text.match(/(?:من\s*)?(\d{2})\s*(?:-|–|الى|إلى|لـ|\s+)\s*(\d{2})/);
        if (ageMatch) {
            const a1 = parseInt(ageMatch[1], 10);
            const a2 = parseInt(ageMatch[2], 10);
            if (a1 >= 13 && a1 <= 65 && a2 >= 13 && a2 <= 65) {
                return {
                    action: 'UPDATE_TARGETING',
                    campaignId,
                    targeting: {
                        age_min: Math.min(a1, a2),
                        age_max: Math.max(a1, a2)
                    }
                };
            }
        }
    }

    // 8. تعديل النوع
    if (/(?:نوع|جنس|النوع|الجنس|gender)/i.test(text)) {
        let mappedGender = null;
        let genderLabel = '';
        if (/(?:رجال|ذكور|men|رجالة)/i.test(text)) {
            mappedGender = 'MEN';
            genderLabel = 'رجال فقط 👨';
        } else if (/(?:نساء|اناث|إناث|women|بنات|ستات)/i.test(text)) {
            mappedGender = 'WOMEN';
            genderLabel = 'نساء فقط 👩';
        } else if (/(?:الكل|الجميع|all)/i.test(text)) {
            mappedGender = 'ALL';
            genderLabel = 'الجميع (رجال ونساء)';
        }
        if (mappedGender) {
            return {
                action: 'UPDATE_TARGETING',
                campaignId,
                targeting: { gender: mappedGender },
                genderLabel
            };
        }
    }

    // 9. تعديل المناطق والمحافظات
    const geoMatch = text.match(/(?:مناطق|محافظات|المناطق|المحافظات|مدن|منطقة)[^\d]+(?:الحملة\s+|حمله\s+)?(?:\d{10,25})?\s*(?:خليهم|خليها|هي|هو)?\s*[:=]?\s*([^\n\r]+)/i);
    if (geoMatch && /(?:مناطق|محافظات|مدن)/i.test(text)) {
        let regionsStr = geoMatch[1].replace(campaignId, '').trim();
        regionsStr = regionsStr.replace(/^(?:الحملة|حمله|دي|رقم)\s*/i, '').trim();
        if (regionsStr.length > 2) {
            return {
                action: 'UPDATE_TARGETING',
                campaignId,
                targeting: { regions: regionsStr },
                regionsRaw: regionsStr
            };
        }
    }

    // 10. تعديل الاهتمامات
    const interestMatch = text.match(/(?:اهتمامات|اهتمام|الاهتمامات|interests)[^\d]+(?:الحملة\s+|حمله\s+)?(?:\d{10,25})?\s*(?:خليهم|خليها|هي|هو)?\s*[:=]?\s*([^\n\r]+)/i);
    if (interestMatch && /(?:اهتمامات|اهتمام)/i.test(text)) {
        let rawInterests = interestMatch[1].replace(campaignId, '').trim();
        rawInterests = rawInterests.replace(/^(?:الحملة|حمله|دي|رقم)\s*/i, '').trim();
        const interestsList = rawInterests.split(/[,،]/).map(s => s.trim()).filter(Boolean);
        if (interestsList.length > 0) {
            return {
                action: 'UPDATE_TARGETING',
                campaignId,
                targeting: { interests: interestsList },
                interestsRaw: rawInterests
            };
        }
    }

    // 11. تغيير اسم الحملة
    const renameMatch = text.match(/(?:اسم|تسمية|تسميه|غير اسم|تغيير اسم|rename)[^\d]+(?:الحملة\s+|حمله\s+)?(?:\d{10,25})?\s*(?:لـ|الى|إلى|خليه|خليها|باسم|هو)?\s*[:=]?\s*([^\n\r]+)/i);
    if (renameMatch && /(?:اسم|تسمية|تسميه|rename)/i.test(text)) {
        let newName = renameMatch[1].replace(campaignId, '').trim();
        newName = newName.replace(/^(?:الحملة|حمله|دي|رقم|لـ|الى|إلى)\s*/i, '').trim();
        if (newName.length > 2) {
            return {
                action: 'RENAME',
                campaignId,
                name: newName
            };
        }
    }

    // 12. دبلكييت / نسخ الحملة
    if (/(?:دبلكييت|دوبلكيت|دبلكيت|نسخ|تكرار|اعمل نسخة|اعمل نسخه|كرر|كررها|انسخ|duplicate|copy)/i.test(text)) {
        return {
            action: 'DUPLICATE',
            campaignId
        };
    }

    return null;
}

/**
 * التحقق هل الرسالة عبارة عن أمر تحكم بالحملات الإعلانية
 */
export function isCampaignManagementCommand(rawText = '') {
    if (!rawText || typeof rawText !== 'string') return false;
    return !!parseConversationalCampaignCommand(rawText);
}

/**
 * معالجة أوامر التحكم السريع بالحملات الإعلانية من الواتساب
 * بأسلوب الميديا باير الطبيعي (إيقاف، تشغيل، تعديل ميزانية، تمديد، ضبط السن، النوع، المناطق، الاهتمامات، تغيير الاسم، نسخ الحملة)
 */
export async function handleCampaignManagementCommand({ sock, remoteJid, raw, senderPhone }) {
    const cmd = parseConversationalCampaignCommand(raw);
    if (!cmd) {
        return false;
    }

    const { campaignId, action } = cmd;

    // 1. أمر إيقاف الحملة
    if (action === 'UPDATE_STATUS' && cmd.status === 'PAUSED') {
        await sendGroupReply(sock, remoteJid, { text: `⏳ جاري إيقاف الحملة \`${campaignId}\`...` });
        const res = await callManageCampaignApi({
            action: 'UPDATE_STATUS',
            target_id: campaignId,
            status: 'PAUSED'
        });
        if (res.success) {
            await sendGroupReply(sock, remoteJid, {
                text: `⏸️ *تمام يا فندم، وقفتلك الحملة بنجاح!*\n\n` +
                      `📌 *المعرف:* \`${campaignId}\`\n` +
                      `📊 *الحالة الجديدة:* متوقفة مؤقتاً (PAUSED)\n` +
                      `💡 *لو حابب تشغلها في أي وقت:* قولي "شغل الحملة ${campaignId}" 🟢`
            });
        } else {
            await sendGroupReply(sock, remoteJid, {
                text: `❌ *تعذر إيقاف الحملة:*\n${res.error || 'حدث خطأ غير متوقع في Meta API'}`
            });
        }
        return true;
    }

    // 2. أمر تشغيل الحملة
    if (action === 'UPDATE_STATUS' && cmd.status === 'ACTIVE') {
        await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تفعيل وتشغيل الحملة \`${campaignId}\`...` });
        const res = await callManageCampaignApi({
            action: 'UPDATE_STATUS',
            target_id: campaignId,
            status: 'ACTIVE'
        });
        if (res.success) {
            await sendGroupReply(sock, remoteJid, {
                text: `🟢 *تمام يا فندم، شغلتلك الحملة بنجاح!*\n\n` +
                      `📌 *المعرف:* \`${campaignId}\`\n` +
                      `📊 *الحالة الجديدة:* نشطة وشغالة (ACTIVE)\n` +
                      `💡 *للإيقاف المؤقت:* قولي "وقف الحملة ${campaignId}" ⏸️`
            });
        } else {
            await sendGroupReply(sock, remoteJid, {
                text: `❌ *تعذر تشغيل الحملة:*\n${res.error || 'حدث خطأ غير متوقع في Meta API'}`
            });
        }
        return true;
    }

    // 3. أمر تعديل الميزانية
    if (action === 'UPDATE_BUDGET') {
        const budgetAmount = cmd.amount;
        const isLifetime = !!cmd.isLifetime;
        await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تعديل ميزانية الحملة \`${campaignId}\` إلى ${budgetAmount} ج.م...` });

        const payload = {
            action: 'UPDATE_BUDGET',
            target_id: campaignId
        };
        if (isLifetime) {
            payload.lifetime_budget = budgetAmount;
        } else {
            payload.daily_budget = budgetAmount;
        }

        const res = await callManageCampaignApi(payload);
        if (res.success) {
            await sendGroupReply(sock, remoteJid, {
                text: `💵 *تمام يا فندم، عدلتلك ميزانية الحملة بنجاح!*\n\n` +
                      `📌 *المعرف:* \`${campaignId}\`\n` +
                      `💰 *الميزانية الجديدة:* ${res.budget_formatted || `${budgetAmount} ج.م`}\n` +
                      `📊 *النوع:* ${res.budget_type || (isLifetime ? 'إجمالية' : 'يومية')}`
            });
        } else {
            await sendGroupReply(sock, remoteJid, {
                text: `❌ *فشل تعديل الميزانية:*\n${res.error || 'حدث خطأ في Meta API'}`
            });
        }
        return true;
    }

    // 4. أمر تمديد الحملة أو تاريخ الانتهاء
    if (action === 'UPDATE_STOP_TIME') {
        if (cmd.extendDays) {
            const days = cmd.extendDays;
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تمديد الحملة \`${campaignId}\` بمقدار ${days} يوم...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_STOP_TIME',
                target_id: campaignId,
                extend_days: days
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `⏳ *تمام يا فندم، مددتلك فترة الحملة بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `➕ *المدة المضافة:* ${days} يوم\n` +
                          `🏁 *النتيجة:* ${res.message || 'تم تمديد موعد انتهاء الحملة بنجاح'}`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تمديد الحملة:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }

        if (cmd.stopTime === 'never') {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري ضبط الحملة \`${campaignId}\` لتكون مستمرة بدون انتهاء...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_STOP_TIME',
                target_id: campaignId,
                stop_time: 'never'
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `♾️ *تمام يا فندم، الحملة الآن تعمل بشكل مستمر بدون تاريخ انتهاء!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `الحملة ستستمر بالعمل حتى تقوم بإيقافها في أي وقت.`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث الحملة:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }

        if (cmd.stopTime) {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري ضبط موعد انتهاء الحملة \`${campaignId}\` إلى ${cmd.stopTime}...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_STOP_TIME',
                target_id: campaignId,
                stop_time: cmd.stopTime
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `⏳ *تمام يا فندم، تم تحديث موعد الانتهاء بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `🏁 ${res.message}`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث تاريخ الانتهاء:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }
    }

    // 5. تعديل الاستهداف
    if (action === 'UPDATE_TARGETING') {
        const targeting = cmd.targeting;
        if (targeting.age_min) {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تعديل الفئة العمرية للحملة \`${campaignId}\` إلى (${targeting.age_min} - ${targeting.age_max} سنة)...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_TARGETING',
                target_id: campaignId,
                targeting: {
                    age_min: targeting.age_min,
                    age_max: targeting.age_max
                }
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `🎯 *تمام يا فندم، تم تحديث الفئة العمرية بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `👥 *السن المحدث:* من ${targeting.age_min} إلى ${targeting.age_max} سنة\n` +
                          `💡 *ملاحظة:* تم التوافق مع إعدادات Advantage+ Audience تلقائياً.`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث الاستهداف:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }

        if (targeting.gender) {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تعديل استهداف الجنس للحملة \`${campaignId}\` إلى (${cmd.genderLabel})...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_TARGETING',
                target_id: campaignId,
                targeting: {
                    gender: targeting.gender
                }
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `🎯 *تمام يا فندم، تم تحديث استهداف الجنس بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `👥 *الجنس المستهدف:* ${cmd.genderLabel}`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث استهداف الجنس:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }

        if (targeting.regions) {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تحديث المناطق المستهدفة للحملة \`${campaignId}\` (${cmd.regionsRaw})...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_TARGETING',
                target_id: campaignId,
                targeting: {
                    regions: targeting.regions
                }
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `📍 *تمام يا فندم، تم تحديث المناطق المستهدفة بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `🗺️ *المناطق المحددة:* ${cmd.regionsRaw}`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث المناطق:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }

        if (targeting.interests) {
            await sendGroupReply(sock, remoteJid, { text: `⏳ جاري مطابقة وتحديث الاهتمامات للحملة \`${campaignId}\`...` });

            const res = await callManageCampaignApi({
                action: 'UPDATE_TARGETING',
                target_id: campaignId,
                targeting: {
                    interests: targeting.interests
                }
            });

            if (res.success) {
                await sendGroupReply(sock, remoteJid, {
                    text: `🎯 *تمام يا فندم، تم تحديث الاهتمامات بنجاح!*\n\n` +
                          `📌 *المعرف:* \`${campaignId}\`\n` +
                          `🏷️ *الاهتمامات:* ${cmd.interestsRaw}`
                });
            } else {
                await sendGroupReply(sock, remoteJid, {
                    text: `❌ *فشل تحديث الاهتمامات:*\n${res.error || 'حدث خطأ في Meta API'}`
                });
            }
            return true;
        }
    }

    // 6. تغيير اسم الحملة
    if (action === 'RENAME') {
        const newName = cmd.name;
        await sendGroupReply(sock, remoteJid, { text: `⏳ جاري تغيير اسم الحملة \`${campaignId}\`...` });

        const res = await callManageCampaignApi({
            action: 'RENAME',
            target_id: campaignId,
            name: newName
        });

        if (res.success) {
            await sendGroupReply(sock, remoteJid, {
                text: `✏️ *تمام يا فندم، تم تغيير اسم الحملة بنجاح!*\n\n` +
                      `📌 *المعرف:* \`${campaignId}\`\n` +
                      `📝 *الاسم الجديد:* ${newName}`
            });
        } else {
            await sendGroupReply(sock, remoteJid, {
                text: `❌ *فشل تغيير اسم الحملة:*\n${res.error || 'حدث خطأ في Meta API'}`
            });
        }
        return true;
    }

    // 7. نسخ الحملة (Duplicate)
    if (action === 'DUPLICATE') {
        await sendGroupReply(sock, remoteJid, { text: `⏳ جاري عمل نسخة (Duplicate) متطابقة للحملة \`${campaignId}\`...` });

        const res = await callManageCampaignApi({
            action: 'DUPLICATE',
            target_id: campaignId
        });

        if (res.success) {
            await sendGroupReply(sock, remoteJid, {
                text: `📋 *تمام يا فندم، تم نسخ الحملة بنجاح!*\n\n` +
                      `📌 *المعرف الأصلي:* \`${campaignId}\`\n` +
                      `🆕 *معرف النسخة الجديدة:* \`${res.copied_id}\`\n` +
                      `⏸️ *الحالة:* متوقفة مؤقتاً لتجهيزها قبل النشر.\n` +
                      `💡 *لتشغيل النسخة:* قولي "شغل ${res.copied_id}" 🚀`
            });
        } else {
            await sendGroupReply(sock, remoteJid, {
                text: `❌ *فشل نسخ الحملة:*\n${res.error || 'حدث خطأ في Meta API'}`
            });
        }
        return true;
    }

    return false;
}


/**
 * معالجة رسائل جروب تقارير الإعلانات
 */
export async function handleAdsReportGroupMessage({
    sock,
    remoteJid,
    senderPhone,
    participantJid,
    text,
    msg,
    groupMetadata,
    userId = 3,
    io
}) {
    if (!text || text.trim().length === 0) return true;

    // 1. التحقق من صلاحية الرقم المرسل (الأدمن والمشرفين المعتمدين فقط)
    const authorized = await isAuthorizedAdsAdmin(senderPhone, userId, participantJid);
    if (!authorized) {
        console.log(`🔒 [Ads Report Group] Message ignored from unauthorized participant: ${senderPhone || participantJid}`);
        return true;
    }

    // تأكيد تعيين رقم راضي إذا كان المرسل هو راضي عبر الـ LID
    const pStr = String(participantJid || '');
    const sStr = String(senderPhone || '');
    if (!senderPhone || sStr.includes('@lid') || sStr === remoteJid.replace('@g.us', '')) {
        if (pStr.includes('243593499418829') || pStr.includes('01092308465') || pStr.includes('201092308465') ||
            sStr.includes('243593499418829') || sStr.includes('01092308465') || sStr.includes('201092308465')) {
            senderPhone = '01092308465';
        }
    }

    console.log(`📊 [Ads Report Group] Authorized admin command from ${senderPhone}: "${text}"`);

    const raw = text.trim();

    // 2. فحص أوامر المساعدة أو التعليمات
    if (/^(مساعدة|التعليمات|اوامر|الأوامر|شرح|help)$/i.test(raw)) {
        const helpMsg = `📊 *دليل استخدام جروب تقارير وإدارة الإعلانات:*\n\n` +
            `🔹 *لجلب تقرير الحساب الإعلاني:* أرسل رقم الحساب مباشرة:\n` +
            `   - \`1234567890\`\n` +
            `   - "تقرير الحساب 1234567890"\n` +
            `   - "1234567890 امبارح" أو "اخر 7 ايام" أو "هذا الشهر"\n\n` +
            `🔹 *لجلب تقرير أداء حملة معينة:* أرسل رقم الحملة:\n` +
            `   - "حملة 120252812532900334"\n\n` +
            `⚡ *أوامر التحكم السريع بالحملات:*\n` +
            `   - ⏸️ *إيقاف حملة:* \`وقف 120248649213580630\`\n` +
            `   - 🟢 *تشغيل حملة:* \`شغل 120248649213580630\`\n` +
            `   - 💵 *تعديل ميزانية:* \`ميزانية 120248649213580630 500\`\n` +
            `   - ⏳ *تمديد الحملة:* \`تمديد 120248649213580630 3 ايام\`\n` +
            `   - 🎯 *تعديل السن:* \`سن 120248649213580630 25-45\`\n` +
            `   - 👥 *تعديل الجنس:* \`نوع 120248649213580630 رجال\` (أو نساء / الكل)\n` +
            `   - 📍 *تعديل المناطق:* \`مناطق 120248649213580630 القاهرة, الجيزة\`\n` +
            `   - 🏷️ *تعديل الاهتمامات:* \`اهتمامات 120248649213580630 تسوق, ملابس\`\n` +
            `   - ✏️ *تغيير الاسم:* \`اسم 120248649213580630 حملة الشتاء\`\n` +
            `   - 📋 *دبلكييت / نسخ:* \`دبلكييت 120248649213580630\`\n\n` +
            `🦅 *لفحص وتدقيق استهداف الحملة بالذكاء الاصطناعي:*\n` +
            `   - "استهداف 120251807851810053"\n` +
            `   - "استهداف 120251807851810053 ركز على تجار الجملة والمحافظات"`;
        await sendGroupReply(sock, remoteJid, { text: helpMsg });
        return true;
    }

    // 2.4 فحص وتنفيذ أوامر التحكم وإدارة الحملات (إيقاف، تشغيل، ميزانية، تمديد، سن، نوع، مناطق، اهتمامات، اسم، نسخ)
    const handledManagement = await handleCampaignManagementCommand({
        sock,
        remoteJid,
        raw,
        senderPhone
    });
    if (handledManagement) {
        return true;
    }

    // 2.5 فحص طلب تدقيق وفحص استهداف الحملة بالذكاء الاصطناعي (عين السوق 🦅)
    if (isCampaignTargetingCommand(raw, remoteJid) || isPlainTargetingCommand(raw)) {
        await handleCampaignTargetingMessage({
            sock,
            remoteJid,
            phoneNumber: senderPhone,
            participantJid,
            text: raw,
            userId,
            io,
            isGroup: true
        });
        return true;
    }

    // 3. استخراج المعرف والفترة الزمنية وفلتر الحالة
    const datePreset = extractDatePreset(raw);
    const statusFilter = extractStatusFilter(raw);
    const idInfo = extractAdIdentifiers(raw);

    if (!idInfo) {
        // رسالة إرشادية في حال كتب نصاً بدون أي أرقام حسابات
        await sendGroupReply(sock, remoteJid, {
            text: `ℹ️ يرجى إرسال رقم الحساب الإعلاني (Ad Account ID) أو رقم الحملة للاستعلام عنها.\n\n💡 مثال:\n"تقرير الحساب 1234567890 اليوم"\nأو أرسل الرقم مباشرة: \`1234567890\` 📊`
        });
        return true;
    }

    // إشعار جارِ الجلب
    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    let isExplicitCampaign = (idInfo.type === 'campaign');
    let apiResult = null;
    let campaignYesterdayResult = null;

    if (idInfo.type === 'campaign') {
        // طلب صريح لحملة: جلب أداء اليوم وأمس معاً بالتوازي لعرضهما للعميل مباشرة
        const [todayRes, yestRes] = await Promise.all([
            fetchCampaignsSummary({
                campaign_ids: [idInfo.id],
                date_preset: 'today',
                status_filter: 'ALL',
                force_refresh: true
            }),
            fetchCampaignsSummary({
                campaign_ids: [idInfo.id],
                date_preset: 'yesterday',
                status_filter: 'ALL',
                force_refresh: true
            })
        ]);
        apiResult = (todayRes && todayRes.success) ? todayRes : yestRes;
        campaignYesterdayResult = (yestRes && yestRes.success) ? yestRes : null;
        isExplicitCampaign = true;
    } else if (idInfo.type === 'account') {
        // طلب صريح لحساب: يظل كما هو تماماً دون أي تعديل
        apiResult = await fetchCampaignsSummary({
            account_id: idInfo.id,
            date_preset: datePreset,
            status_filter: statusFilter,
            force_refresh: true
        });
    } else {
        // نوع غير محدد: نجرب كحساب إعلاني أولاً (كما هو مطلوب للحسابات دون أي تعديل)
        apiResult = await fetchCampaignsSummary({
            account_id: idInfo.id,
            date_preset: datePreset,
            status_filter: statusFilter,
            force_refresh: true
        });

        // إذا لم ينجح كحساب إعلاني، نجرب كمعرف حملة تلقائياً (جلب اليوم وأمس)
        if (!apiResult || !apiResult.success) {
            console.log(`🔄 [Ads Report] Trying fallback for ID ${idInfo.id} as campaign_id...`);
            const [todayRes, yestRes] = await Promise.all([
                fetchCampaignsSummary({
                    campaign_ids: [idInfo.id],
                    date_preset: 'today',
                    status_filter: 'ALL',
                    force_refresh: true
                }),
                fetchCampaignsSummary({
                    campaign_ids: [idInfo.id],
                    date_preset: 'yesterday',
                    status_filter: 'ALL',
                    force_refresh: true
                })
            ]);
            if ((todayRes && todayRes.success) || (yestRes && yestRes.success)) {
                apiResult = (todayRes && todayRes.success) ? todayRes : yestRes;
                campaignYesterdayResult = (yestRes && yestRes.success) ? yestRes : null;
                isExplicitCampaign = true;
            }
        }
    }

    if (!apiResult || !apiResult.success) {
        const errMsg = apiResult?.error || apiResult?.message || 'تعذر الاتصال بخادم الإعلانات.';
        console.error(`❌ [Ads Report] Failed to fetch report for ID ${idInfo.id}:`, errMsg);
        let userErr = `⚠️ *تعذر جلب تقرير الإعلانات للمعرف (${idInfo.id}):*\n\n`;
        if (errMsg.includes('#200') || errMsg.includes('permission')) {
            userErr += `📌 *السبب:* الحساب غير مربوط بالمنصة أو لم يتم منحه صلاحيات قراءة الإعلانات (ads_read) في فيسبوك.`;
        } else {
            userErr += `📌 *السبب:* ${errMsg}`;
        }
        await sendGroupReply(sock, remoteJid, { text: userErr });
        return true;
    }

    // 4. صياغة التقرير الاحترافي وإرساله
    const reportText = isExplicitCampaign
        ? formatCampaignAdsReportMessage(apiResult, campaignYesterdayResult, idInfo.id)
        : formatAdsReportMessage(apiResult, idInfo.id, datePreset, isExplicitCampaign, statusFilter);
    await sendGroupReply(sock, remoteJid, { text: reportText });
    return true;
}
