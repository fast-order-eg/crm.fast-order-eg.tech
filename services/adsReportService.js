import { getSetting } from './settingsService.js';
import { getAuthorizedAdmins, normalizePhoneDigits, PRIMARY_ADMIN } from './reminderService.js';

const API_ENDPOINT = 'https://einasouq.bird-ads.com/api/v1/merchant/campaigns-summary';
const API_KEY = 'fastorder_merchant_secure_api_key_2026';

/**
 * التحقق هل المرسل مشرف مصرح له بإدارة واستعراض تقارير الإعلانات
 */
export async function isAuthorizedAdsAdmin(senderPhone, userId = 3, participantJid = '') {
    const s = String(senderPhone || '');
    const p = String(participantJid || '');

    // 1. فحص مباشر لمعرفات الأدمن الأساسي راضي
    if (s.includes('01092308465') || s.includes('201092308465') || s.includes('243593499418829') ||
        p.includes('01092308465') || p.includes('201092308465') || p.includes('243593499418829')) {
        return true;
    }

    if (!senderPhone && !participantJid) return false;

    const cleanSender = normalizePhoneDigits(senderPhone);
    const cleanPart = normalizePhoneDigits(participantJid);

    // فحص المشرفين المعتمدين في النظام
    const admins = await getAuthorizedAdmins(userId);
    return admins.some(a => {
        const adminNorm = normalizePhoneDigits(a.phone);
        return (cleanSender && adminNorm === cleanSender) || (cleanPart && adminNorm === cleanPart);
    });
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
 * استخراج وصياغة روابط المنشورات وفق قواعد API عين السوق:
 * 1. إذا توفر في الحملة رابط فيسبوك (facebook_url) ورابط إنستغرام (instagram_url) معاً، نعرض الرابطين تحت بعض لراحة العميل:
 *    • 🔗 رابط المنشور (فيسبوك): {facebook_url}
 *    • 📸 رابط المنشور (إنستغرام): {instagram_url}
 * 2. إذا توفر رابط واحد فقط أو الرابط الأساسي (post_url):
 *    - لو المنصة فيسبوك:
 *      • 🔗 رابط المنشور (فيسبوك): {post_url}
 *    - لو المنصة إنستغرام:
 *      • 🔗 رابط المنشور (إنستغرام): {post_url}
 * ⛔ تحذير: ممنوع نهائياً تركيب رابط فيسبوك يدوي من effective_object_story_id
 */
export function formatCampaignPostLinks(camp) {
    if (!camp) return '';

    const fbUrl = (camp.facebook_url || camp.primary_ad?.facebook_url || '').trim();
    const instaUrl = (camp.instagram_url || camp.primary_ad?.instagram_url || '').trim();
    const postUrl = (camp.post_url || camp.primary_ad?.post_url || '').trim();

    const isHttp = (u) => typeof u === 'string' && u.startsWith('http');

    // 1. (اختياري احترافي): إذا توفر رابط فيسبوك ورابط إنستغرام معاً
    if (isHttp(fbUrl) && isHttp(instaUrl)) {
        return `• 🔗 رابط المنشور (فيسبوك): ${fbUrl}\n• 📸 رابط المنشور (إنستغرام): ${instaUrl}\n`;
    }

    // 2. إذا توفر رابط واحد فقط
    const targetUrl = postUrl || fbUrl || instaUrl;
    if (!isHttp(targetUrl)) return '';

    const pLabel = String(camp.platform_label || camp.primary_ad?.platform_label || camp.platform || camp.primary_ad?.platform || '').toLowerCase();
    const urlLabel = String(camp.post_url_label || camp.primary_ad?.post_url_label || '');

    let platform = '';
    if (targetUrl === fbUrl || pLabel.includes('فيسبوك') || pLabel.includes('facebook') || urlLabel.includes('فيسبوك') || targetUrl.includes('facebook.com')) {
        platform = 'فيسبوك';
    } else if (targetUrl === instaUrl || pLabel.includes('إنستغرام') || pLabel.includes('إنستجرام') || pLabel.includes('instagram') || urlLabel.includes('إنستغرام') || urlLabel.includes('إنستجرام') || targetUrl.includes('instagram.com')) {
        platform = 'إنستغرام';
    }

    if (platform === 'فيسبوك') {
        return `• 🔗 رابط المنشور (فيسبوك): ${targetUrl}\n`;
    } else if (platform === 'إنستغرام') {
        return `• 🔗 رابط المنشور (إنستغرام): ${targetUrl}\n`;
    } else if (urlLabel) {
        return `• 🔗 ${urlLabel}: ${targetUrl}\n`;
    } else {
        return `• 🔗 رابط المنشور: ${targetUrl}\n`;
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
export function formatAdsReportMessage(data, requestedId = '', datePreset = 'today', isExplicitCampaign = false, statusFilter = 'ACTIVE') {
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

    if (idInfo.type === 'campaign') {
        // طلب صريح لحملة
        apiResult = await fetchCampaignsSummary({
            campaign_ids: [idInfo.id],
            date_preset: datePreset,
            status_filter: statusFilter,
            force_refresh: true
        });
    } else if (idInfo.type === 'account') {
        // طلب صريح لحساب
        apiResult = await fetchCampaignsSummary({
            account_id: idInfo.id,
            date_preset: datePreset,
            status_filter: statusFilter,
            force_refresh: true
        });
    } else {
        // نوع غير محدد: نجرب كحساب إعلاني أولاً
        apiResult = await fetchCampaignsSummary({
            account_id: idInfo.id,
            date_preset: datePreset,
            status_filter: statusFilter,
            force_refresh: true
        });

        // إذا لم ينجح كحساب إعلاني، نجرب كمعرف حملة تلقائياً
        if (!apiResult || !apiResult.success) {
            console.log(`🔄 [Ads Report] Trying fallback for ID ${idInfo.id} as campaign_id...`);
            const campaignTry = await fetchCampaignsSummary({
                campaign_ids: [idInfo.id],
                date_preset: datePreset,
                status_filter: statusFilter,
                force_refresh: true
            });
            if (campaignTry && campaignTry.success) {
                apiResult = campaignTry;
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
    const reportText = formatAdsReportMessage(apiResult, idInfo.id, datePreset, isExplicitCampaign, statusFilter);
    await sendGroupReply(sock, remoteJid, { text: reportText });
    return true;
}
