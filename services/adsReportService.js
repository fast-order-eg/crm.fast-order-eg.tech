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
 * استخراج روابط المنشورات الفعلية المباشرة من الهيكل الهرمي الكامل
 * مع إعطاء الأولوية لمنشور صفحة الفيسبوك الأصلي (effective_object_story_id) لضمان أنه يفتح مع أي شخص بدون تسجيل دخول
 */
export function extractCampaignPostLinks(camp) {
    if (!camp) return [];
    const links = [];
    const seen = new Set();

    const addLink = (rawUrl, preferredPlatform = '') => {
        if (!rawUrl || typeof rawUrl !== 'string') return;
        const url = rawUrl.trim();
        if (seen.has(url)) return;
        seen.add(url);

        let platform = preferredPlatform || 'منشور';
        if (!preferredPlatform) {
            if (url.includes('facebook.com/')) {
                platform = 'فيسبوك';
            } else if (url.includes('instagram.com/')) {
                platform = 'إنستجرام';
            } else if (url.startsWith('http')) {
                platform = 'رابط خارجي';
            }
        }

        links.push({ url, platform });
    };

    const processCreative = (cr) => {
        if (!cr) return;

        // 1. الأولوية القصوى: رابط المنشور الحقيقي على صفحة الفيسبوك من effective_object_story_id (شغال ومفتوح للجميع)
        if (cr.effective_object_story_id && String(cr.effective_object_story_id).includes('_')) {
            const [pageId, postId] = String(cr.effective_object_story_id).split('_');
            if (pageId && postId) {
                addLink(`https://www.facebook.com/${pageId}/posts/${postId}`, 'فيسبوك');
            }
        }

        // 2. إذا كان هناك رابط فيسبوك صريح في post_url أو preview_url
        if (cr.post_url && cr.post_url.includes('facebook.com/')) {
            addLink(cr.post_url, 'فيسبوك');
        } else if (cr.preview_url && cr.preview_url.includes('facebook.com/')) {
            addLink(cr.preview_url, 'فيسبوك');
        }

        // 3. رابط إنستجرام إذا لم نجد رابط فيسبوك (مثلاً إعلان معمول حصرياً لإنستجرام)
        if (links.length === 0) {
            const instaUrl = cr.instagram_permalink_url || (cr.post_url && cr.post_url.includes('instagram.com') ? cr.post_url : null);
            if (instaUrl) {
                addLink(instaUrl, 'إنستجرام');
            }
        }

        // 4. رابط خارجي إن وجد
        if (cr.link_url && !cr.link_url.includes('facebook.com') && !cr.link_url.includes('instagram.com')) {
            addLink(cr.link_url, 'رابط الإعلان');
        }
    };

    // 1. من خلال الهيكل الهرمي: campaign -> adsets -> ads -> creative
    if (Array.isArray(camp.adsets) && camp.adsets.length > 0) {
        for (const adset of camp.adsets) {
            if (Array.isArray(adset.ads) && adset.ads.length > 0) {
                for (const ad of adset.ads) {
                    processCreative(ad.creative);
                }
            }
        }
    }

    // 2. فحص مصفوفة الإعلانات المباشرة كاحتياط
    if (Array.isArray(camp.ads) && camp.ads.length > 0) {
        for (const ad of camp.ads) {
            processCreative(ad.creative);
        }
    }

    // 3. رابط المنشور المباشر بالحملة إن وجد
    if (camp.post_url) {
        addLink(camp.post_url);
    }

    return links;
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
export function formatAdsReportMessage(data, requestedId = '', datePreset = 'today', isExplicitCampaign = false) {
    const presetLabels = {
        today: 'اليوم',
        yesterday: 'أمس',
        last_7d: 'آخر 7 أيام',
        this_month: 'هذا الشهر',
        maximum: 'كل الفترات (الإجمالي)'
    };
    const periodLabel = presetLabels[datePreset] || datePreset;

    const rawCampaigns = data.campaigns || [];

    // تصفية الحملات: إذا لم يكن الاستعلام عن حملة محددة بعينها، نعرض الحملات النشطة والشغالة فقط
    const campaigns = isExplicitCampaign
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
        const cStatus = camp.status === 'ACTIVE' ? '🟢 نشطة' : '⏸️ متوقفة';
        const ctaType = camp.ads?.[0]?.creative?.cta_type || '';
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
        const postLinks = extractCampaignPostLinks(camp);
        if (postLinks.length === 1) {
            msg += `• 🔗 رابط المنشور (${postLinks[0].platform}): ${postLinks[0].url}\n`;
        } else if (postLinks.length > 1) {
            msg += `• 🔗 روابط المنشورات (${postLinks.length}):\n`;
            postLinks.forEach((pl, pIdx) => {
                msg += `  ${pIdx + 1}. ${pl.url} (${pl.platform})\n`;
            });
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

    let isExplicitCampaign = (idInfo.type === 'campaign');
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
                isExplicitCampaign = true;
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
    const reportText = formatAdsReportMessage(apiResult, idInfo.id, datePreset, isExplicitCampaign);
    await sendGroupReply(sock, remoteJid, { text: reportText });
    return true;
}
