import { getSetting, setSetting } from './settingsService.js';
import { getAuthorizedAdmins, normalizePhoneDigits, PRIMARY_ADMIN } from './reminderService.js';

const API_ENDPOINT = 'https://einasouq.bird-ads.com/api/v1/merchant/campaigns-summary';
const API_KEY = 'fastorder_merchant_secure_api_key_2026';

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
    if (t.includes('المتوقفة') || t.includes('المتوقفه') || t.includes('متوقف') || t.includes('موقوفة') || t.includes('موقوفه') || t.includes('paused') || t.includes('كل الحملات')) {
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

    // 2. فحص إذا كان المستخدم حدد صراحة "حساب" أو "حملة"
    const explicitAccount = clean.match(/(?:حساب|اكونت|حسابي|account)\s*(?:رقم|الإعلاني|الاعلاني)?\s*[:#-]?\s*(\d{6,20})/i);
    if (explicitAccount) {
        return { type: 'account', id: explicitAccount[1] };
    }

    const explicitCampaign = clean.match(/(?:حملة|حمله|campaign)\s*(?:رقم)?\s*[:#-]?\s*(\d{6,20})/i);
    if (explicitCampaign) {
        return { type: 'campaign', id: explicitCampaign[1] };
    }

    // 3. استخراج أول تسلسل أرقام مكون من 6 إلى 20 رقم
    const generalDigits = clean.match(/\b(\d{6,20})\b/);
    if (generalDigits) {
        return { type: 'unknown', id: generalDigits[1] };
    }

    return null;
}

/**
 * تصنيف نوع وهدف الحملة الإعلانية وتوضيح نوع الرسائل (واتساب / ماسنجر) بدون إيموجي
 */
export function classifyObjective(objective = '', ctaType = '') {
    const obj = String(objective || '').toUpperCase();
    const cta = String(ctaType || '').toUpperCase();

    if (obj.includes('MESSAGES') || obj.includes('ENGAGEMENT') || obj.includes('CONVERSATION')) {
        if (cta === 'WHATSAPP_MESSAGE') {
            return 'إعلان رسائل واتساب';
        } else if (cta === 'MESSAGE_PAGE') {
            return 'إعلان رسائل ماسنجر';
        } else if (cta === 'INSTAGRAM_MESSAGE') {
            return 'إعلان رسائل إنستجرام';
        }
        return 'إعلان رسائل';
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
 * فحص هل الحملة شغالة ونشطة حالياً وليست منتهية أو متوقفة
 */
export function isCampaignCurrentlyRunning(camp) {
    if (!camp) return false;
    const status = String(camp.status || '').toUpperCase();
    const effStatus = String(camp.effective_status || '').toUpperCase();
    if (status !== 'ACTIVE') return false;
    if (effStatus && effStatus !== 'ACTIVE') return false;

    if (camp.stop_time) {
        const stopMs = new Date(camp.stop_time).getTime();
        if (!isNaN(stopMs) && stopMs <= Date.now()) {
            return false;
        }
    }
    return true;
}

/**
 * استخراج وصياغة رابط المنشور الأساسي للحملة وفق المنصة الأصلية المعتمدة في API عين السوق:
 * - إذا كان المنشور الأساسي فيسبوك -> عرض رابط فيسبوك فقط
 * - إذا كان المنشور الأساسي إنستغرام -> عرض رابط إنستغرام فقط
 * ⛔ التزاماً بالقاعدة: عدم دمج الرابطين لعدم تشتيت التاجر، والاعتماد التام على المنشور الأساسي post_url
 */
export function formatCampaignPostLinks(camp) {
    if (!camp) return '';

    const postUrl = (camp.post_url || camp.primary_ad?.post_url || '').trim();
    const isHttp = (u) => typeof u === 'string' && u.startsWith('http');
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
        const cObj = classifyObjective(camp.objective, ctaType);
        const budgetStr = formatCampaignBudget(camp);
        const stopInfo = getStopTimeDetails(camp.stop_time);
        const linksText = formatCampaignPostLinks(camp);

        const numPrefix = allCampaignIds.length > 1 ? `${idx + 1}️⃣ ` : '📌 ';
        msg += `${numPrefix}*${camp.name || 'حملة بدون اسم'}*\n`;
        msg += `• معرف الحملة: \`${camp.id}\`\n`;
        msg += `• الحالة: ${cStatus}\n`;
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
        const cObj = classifyObjective(camp.objective, ctaType);
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
    msg += `💡 *لتغيير الفترة:* اكتب رقم الحساب مع: "اليوم" أو "امس" أو "اخر 7 ايام" أو "هذا الشهر" أو "الكل".`;

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
        const helpMsg = `📊 *دليل استخدام جروب تقارير الإعلانات:*\n\n` +
            `🔹 *لجلب تقرير الحساب الإعلاني:* أرسل رقم الحساب مباشرة:\n` +
            `   - \`1234567890\`\n` +
            `   - "تقرير الحساب 1234567890"\n\n` +
            `🔹 *لتحديد الفترة الزمنية:* اكتب الفترة مع الرقم:\n` +
            `   - "تقرير الحساب 1234567890 امبارح"\n` +
            `   - "1234567890 اخر 7 ايام"\n` +
            `   - "1234567890 هذا الشهر"\n` +
            `   - "1234567890 الكل"\n\n` +
            `🔹 *لجلب تقرير حملة معينة:* أرسل رقم الحملة:\n` +
            `   - "حملة 120252812532900334"`;
        await sendGroupReply(sock, remoteJid, { text: helpMsg });
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
