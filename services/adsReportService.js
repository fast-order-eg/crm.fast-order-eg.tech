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
 * استخراج الفترة الزمنية المطلوبة من رسالة المستخدم
 */
export function extractDatePreset(text = '') {
    const t = text.toLowerCase();
    if (t.includes('امبارح') || t.includes('امس') || t.includes('أمس') || t.includes('yesterday')) {
        return 'yesterday';
    }
    if (t.includes('اخر 7') || t.includes('آخر 7') || t.includes('اسبوع') || t.includes('أسبوع') || t.includes('last_7d') || t.includes('7 ايام') || t.includes('7 أيام')) {
        return 'last_7d';
    }
    if (t.includes('الشهر') || t.includes('هذا الشهر') || t.includes('الشهر الحالي') || t.includes('this_month')) {
        return 'this_month';
    }
    if (t.includes('الكل') || t.includes('الإجمالي') || t.includes('اجمالي') || t.includes('كل الوقت') || t.includes('maximum') || t.includes('all')) {
        return 'maximum';
    }
    return 'today';
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
 * تصنيف نوع وهدف الحملة الإعلانية
 */
export function classifyObjective(objective = '') {
    const obj = String(objective || '').toUpperCase();
    if (obj.includes('SALES') || obj.includes('PURCHASE')) {
        return 'إعلان مبيعات 🛍️';
    } else if (obj.includes('MESSAGES') || obj.includes('ENGAGEMENT') || obj.includes('CONVERSATION')) {
        return 'إعلان رسائل 💬';
    } else if (obj.includes('LEAD')) {
        return 'إعلان تجميع بيانات 📋';
    } else if (obj.includes('TRAFFIC')) {
        return 'إعلان زيارات 🌐';
    }
    return 'إعلان ممول 📢';
}

/**
 * تنسيق تاريخ وساعة الانتهاء والوقت المتبقي بتوقيت القاهرة
 */
export function formatStopTime(stopTimeStr) {
    if (!stopTimeStr) return null;
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
        return `${formattedDate} (منتهي ⏹️)`;
    }

    const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;

    let remainingText = '';
    if (days > 0) {
        remainingText = `متبقي ${days} يوم${days > 1 ? 'اً' : ''}${remainingHours > 0 ? ` و ${remainingHours} ساعة` : ''}`;
    } else if (remainingHours > 0) {
        remainingText = `متبقي ${remainingHours} ساعة`;
    } else {
        const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
        remainingText = `متبقي ${mins} دقيقة`;
    }

    return `${formattedDate} (${remainingText} ⏳)`;
}

/**
 * استدعاء API منصة einasouq.bird-ads.com لجلب نتائج وأداء الحملات
 */
export async function fetchCampaignsSummary({ account_id, campaign_ids, date_preset = 'today' }) {
    const payload = { date_preset };
    if (account_id) payload.account_id = String(account_id).trim();
    if (campaign_ids && Array.isArray(campaign_ids) && campaign_ids.length > 0) {
        payload.campaign_ids = campaign_ids.map(id => String(id).trim());
    }

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        return data;
    } catch (err) {
        console.error('Error fetching campaigns summary from bird-ads API:', err);
        return { success: false, error: err.message };
    }
}

/**
 * صياغة رد الواتساب الاحترافي وفق التعليمات:
 * 1. الأرقام بالإنجليزية (en-US).
 * 2. المصروف رقم صحيح بدون كسور (Spend as whole integer).
 * 3. تمييز نوع الإعلان (مبيعات / رسائل).
 * 4. تاريخ وساعة الانتهاء والمتبقي.
 * 5. إيموجيز مناسبة ومنسقة.
 */
export function formatAdsReportMessage(data, requestedId = '', datePreset = 'today') {
    const currency = data.currency || 'EGP';
    const presetLabels = {
        today: 'اليوم (Today)',
        yesterday: 'أمس (Yesterday)',
        last_7d: 'آخر 7 أيام (Last 7 Days)',
        this_month: 'هذا الشهر (This Month)',
        maximum: 'الإجمالي (All Time)'
    };
    const periodLabel = presetLabels[datePreset] || datePreset;

    const summary = data.summary || {};
    const campaigns = data.campaigns || [];

    const totalSpend = Math.round(Number(summary.total_spend || 0)).toLocaleString('en-US');
    const totalResults = Number(summary.total_results || 0).toLocaleString('en-US');
    const resultLabel = summary.result_label || 'نتائج';
    const avgCpa = Number(summary.average_cpa || 0).toFixed(2);
    const roas = summary.roas ? Number(summary.roas).toFixed(1) : null;
    const reach = Number(summary.total_reach || 0).toLocaleString('en-US');
    const impressions = Number(summary.total_impressions || 0).toLocaleString('en-US');
    const ctr = Number(summary.average_ctr || 0).toFixed(2);

    let msg = `📊 *تقرير أداء الإعلانات الممولة*\n`;
    if (requestedId) msg += `🔢 *المعرف:* \`${requestedId}\`\n`;
    msg += `📅 *الفترة:* ${periodLabel}\n`;
    msg += `💰 *العملة:* ${currency}\n`;
    msg += `════════════════════\n`;

    // الملخص الإجمالي
    msg += `📌 *الملخص الإجمالي:*\n`;
    msg += `• 💵 إجمالي المصروف: *${totalSpend} ${currency}*\n`;
    msg += `• 🎯 إجمالي النتائج: *${totalResults}* (${resultLabel})\n`;
    msg += `• 🏷️ متوسط تكلفة النتيجة (CPA): *${avgCpa} ${currency}*\n`;
    if (roas && Number(roas) > 0) {
        msg += `• 📈 العائد على الإنفاق (ROAS): *${roas}*\n`;
    }
    msg += `• 👥 إجمالي الوصول (Reach): *${reach}*\n`;
    msg += `• 👁️ مرات الظهور (Impressions): *${impressions}*\n`;
    msg += `• 👆 معدل النقر (CTR): *${ctr}%*\n`;
    const activeCount = summary.active_campaigns_count ?? campaigns.filter(c => c.status === 'ACTIVE').length;
    msg += `• 🚀 الحملات النشطة: *${activeCount}* من إجمالي *${campaigns.length}*\n`;

    if (campaigns.length === 0) {
        msg += `════════════════════\n`;
        msg += `ℹ️ لا توجد حملات نشطة أو نتائج مسجلة خلال الفترة المحددة.\n`;
        msg += `💡 جرب تطلب تقرير فترة أوسع مثل: *"اخر 7 ايام"* أو *"هذا الشهر"* أو *"الكل"*.\n`;
        return msg;
    }

    msg += `════════════════════\n`;
    msg += `🎯 *تفاصيل الحملات (${campaigns.length}):*\n\n`;

    campaigns.forEach((camp, idx) => {
        const cStatus = camp.status === 'ACTIVE' ? '🟢 نشطة (ACTIVE)' : '⏸️ متوقفة (PAUSED)';
        const cObj = classifyObjective(camp.objective);
        const cSpend = Math.round(Number(camp.spend || 0)).toLocaleString('en-US');
        const cResults = Number(camp.results || 0).toLocaleString('en-US');
        const cLabel = camp.result_label || resultLabel;
        const cCpa = Number(camp.cpa || 0).toFixed(2);
        const cRoas = camp.roas ? Number(camp.roas).toFixed(1) : null;
        const cCtr = Number(camp.ctr || 0).toFixed(2);
        const cReach = camp.reach ? Number(camp.reach).toLocaleString('en-US') : null;
        const cImpressions = camp.impressions ? Number(camp.impressions).toLocaleString('en-US') : null;
        const endFormatted = formatStopTime(camp.stop_time);

        msg += `${idx + 1}️⃣ *${camp.name || 'حملة بدون اسم'}*\n`;
        msg += `• الحالة: ${cStatus}\n`;
        msg += `• النوع: *${cObj}*\n`;
        msg += `• المصروف: *${cSpend} ${currency}*\n`;
        msg += `• النتائج: *${cResults}* ${cLabel}\n`;
        msg += `• تكلفة النتيجة (CPA): *${cCpa} ${currency}*\n`;
        if (cRoas && Number(cRoas) > 0) {
            msg += `• العائد (ROAS): *${cRoas}*\n`;
        }
        msg += `• معدل النقر (CTR): *${cCtr}%*\n`;
        if (cReach && cImpressions) {
            msg += `• الوصول: *${cReach}* | الظهور: *${cImpressions}*\n`;
        }
        if (endFormatted) {
            msg += `• ميعاد الانتهاء: ${endFormatted}\n`;
        }
        msg += `\n`;
    });

    msg += `════════════════════\n`;
    msg += `💡 *لتغيير الفترة:* اكتب رقم الحساب مع: "اليوم" أو "امس" أو "اخر 7 ايام" أو "هذا الشهر" أو "الكل".`;

    return msg;
}

/**
 * إرسال رسالة في الجروب مع محاكاة كتابة بشرية طبيعية لحماية الحساب من الحظر (Anti-Ban)
 */
async function sendGroupReply(sock, remoteJid, content) {
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            const typingDelay = 1200 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, typingDelay));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    return await sock.sendMessage(remoteJid, content);
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

    // 3. استخراج المعرف والفترة الزمنية
    const datePreset = extractDatePreset(raw);
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

    let apiResult = null;

    if (idInfo.type === 'campaign') {
        // طلب صريح لحملة
        apiResult = await fetchCampaignsSummary({ campaign_ids: [idInfo.id], date_preset: datePreset });
    } else if (idInfo.type === 'account') {
        // طلب صريح لحساب
        apiResult = await fetchCampaignsSummary({ account_id: idInfo.id, date_preset: datePreset });
    } else {
        // نوع غير محدد: نجرب كحساب إعلاني أولاً، فإن كان الخطأ في الصلاحيات/النوع نجرب كمعرف حملة
        apiResult = await fetchCampaignsSummary({ account_id: idInfo.id, date_preset: datePreset });
        if (!apiResult.success && apiResult.error && apiResult.error.includes('#200')) {
            // تجربة المعرف كمعرف حملة مباشرة
            const campaignTry = await fetchCampaignsSummary({ campaign_ids: [idInfo.id], date_preset: datePreset });
            if (campaignTry.success) {
                apiResult = campaignTry;
            }
        }
    }

    if (!apiResult || !apiResult.success) {
        const errMsg = apiResult?.error || 'تعذر الاتصال بخادم الإعلانات.';
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
    const reportText = formatAdsReportMessage(apiResult, idInfo.id, datePreset);
    await sendGroupReply(sock, remoteJid, { text: reportText });
    return true;
}
