import { Op } from 'sequelize';
import GroupReminder from '../models/GroupReminder.js';
import { GoogleAuth } from 'google-auth-library';
import { CONFIG } from '../config.js';

export const SPONSORED_ADS_GROUP_JID = '201092308465-1601429398@g.us';
export const REMINDER_GROUP_JID = '120363411841410393@g.us';

// تحويل الأرقام المشرقية (الهندية) إلى أرقام إنجليزية
export function toEnglishDigits(str) {
    if (!str) return '';
    return String(str).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

/**
 * تحليل رسالة تسجيل الإعلان واستخراج التفاصيل
 */
export function parseSponsoredAd(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = toEnglishDigits(text.trim());
    
    // التحقق من أن الرسالة تخص إعلاناً
    if (!clean.includes('اعلان') && !clean.includes('إعلان')) return null;

    // 1. استخراج المدة بالأيام
    let duration = null;
    const durationMatch = clean.match(/لمد[ةه]\s*(\d+)\s*(يوم|ايام|أيام)/i) 
                       || clean.match(/(\d+)\s*(يوم|ايام|أيام)/i);
    if (durationMatch) {
        duration = parseInt(durationMatch[1], 10);
    } else if (clean.includes('يومين') || clean.includes('لمدة يومين')) {
        duration = 2;
    } else if (clean.includes('يوم واحد') || clean.includes('لمدة يوم')) {
        duration = 1;
    } else if (clean.includes('اسبوع') || clean.includes('أسبوع')) {
        duration = 7;
    } else if (clean.includes('شهر') || clean.includes('لمدة شهر')) {
        duration = 30;
    }

    // 2. استخراج الميزانية / التكلفة
    let budget = null;
    const budgetMatch = clean.match(/(?:ب?تكلف[ةه]|التكلف[ةه]|ميزاني[ةه])\s*(\d+)\s*ج?/i);
    if (budgetMatch) {
        budget = parseInt(budgetMatch[1], 10);
    }

    // 3. استخراج اسم العميل والتفاصيل / الملاحظات
    let clientPart = clean
        .replace(/^(تم\s*)?(انشاء|إنشاء|تجديد)?\s*(إعلان|اعلان)\s*/i, '')
        .split(/(?:ب?تكلف[ةه]|التكلف[ةه]|ميزاني[ةه]|لمد[ةه]|\n)/i)[0]
        .trim();

    // تنظيف أي علامات أو فواصل
    clientPart = clientPart.replace(/^[\\\/ -]+|[\\\/ -]+$/g, '').trim();

    // فحص ما إذا كان الإعلان مستمراً بدون مدة محددة
    const isOngoing = clean.includes('مستمر') || clean.includes('مستمره');

    if (!clientPart && !duration) return null;

    return {
        isAd: true,
        client: clientPart || 'عميل غير محدد',
        duration: duration,
        budget: budget,
        isOngoing: isOngoing && !duration
    };
}

/**
 * حساب تاريخ الانتهاء وموعد التذكير بتوقيت مصر مع تطبيق قاعدة شفت ما بعد منتصف الليل
 */
export function calculateExpiryAndRemindDate(durationDays, now = new Date()) {
    // جلب التوقيت الحالي في جمهورية مصر العربية
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(now);
    const p = {};
    parts.forEach(x => { p[x.type] = parseInt(x.value, 10); });

    let startYear = p.year;
    let startMonth = p.month - 1; // 0-indexed
    let startDay = p.day;
    let currentHour = p.hour;

    // قاعدة الشفت الليلي: إذا سُجل الإعلان بين 12 منتصف الليل و 4:59 فجراً، يعتبر تابعاً لشفت اليوم السابق
    if (currentHour >= 0 && currentHour < 5) {
        const temp = new Date(Date.UTC(startYear, startMonth, startDay - 1));
        startYear = temp.getUTCFullYear();
        startMonth = temp.getUTCMonth();
        startDay = temp.getUTCDate();
    }

    // تاريخ الانتهاء = يوم البداية + (المدة - 1) أيام
    const daysToAdd = Math.max(0, durationDays - 1);
    const expiry = new Date(Date.UTC(startYear, startMonth, startDay + daysToAdd));

    const pad = n => String(n).padStart(2, '0');
    const expiryDateStr = `${expiry.getUTCFullYear()}-${pad(expiry.getUTCMonth() + 1)}-${pad(expiry.getUTCDate())}`;

    // موعد التذكير = الساعة 10:00 صباحاً بتوقيت مصر في نفس يوم الانتهاء
    // توقيت مصر UTC+2، بالتالي 10:00 صباحاً مصر = 08:00 صباحاً UTC
    const remindAtCairoISO = `${expiryDateStr}T10:00:00+02:00`;
    const remindAtUTC = new Date(remindAtCairoISO);

    const daysAr = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const expiryDayName = daysAr[expiry.getUTCDay()];

    return {
        expiryDayName,
        expiryDateStr,
        remindAtUTC
    };
}

/**
 * معالجة الرسائل الواردة في جروب (اعلانات ممولة)
 */
export async function handleSponsoredAdsMessage({
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
    if (!text || msg.key?.fromMe) return false;

    const parsed = parseSponsoredAd(text);
    if (!parsed || !parsed.isAd) return false;

    console.log(`📢 [Sponsored Ads] Detected ad announcement:`, parsed);

    try {
        // إذا كان الإعلان مستمراً بدون تاريخ محدد
        if (parsed.isOngoing) {
            const ongoingMsg = `ℹ️ *تم تسجيل إعلان مستمر بميزانية يومية:*\n\n` +
                `👤 *العميل:* ${parsed.client}\n` +
                `${parsed.budget ? `💰 *الميزانية اليومية:* ${parsed.budget} ج\n` : ''}` +
                `🔄 *الحالة:* إعلان مستمر يومياً (لا يوجد تاريخ انتهاء محدد).`;

            await sock.sendMessage(REMINDER_GROUP_JID, { text: ongoingMsg }).catch(err => {
                console.error('Error sending ongoing notice to reminders:', err.message);
            });

            if (typeof sock.sendMessage === 'function') {
                await sock.sendMessage(remoteJid, {
                    react: { text: '👍', key: msg.key }
                }).catch(() => {});
            }
            return true;
        }

        if (!parsed.duration) {
            console.log('⚠️ [Sponsored Ads] No duration found in ad announcement.');
            return false;
        }

        // حساب تاريخ الانتهاء وموعد التذكير
        const { expiryDayName, expiryDateStr, remindAtUTC } = calculateExpiryAndRemindDate(parsed.duration);

        // 1. تسجيل التذكير المستقل في جدول group_reminders ليتم إطلاقه الساعة 10 ص يوم الانتهاء
        const reminderText = `🔔 انتهاء إعلان العميل (${parsed.client}) النهاردة.\n(يرجى التجديد مع العميل والتأكيد بـ ✅)`;

        const newReminder = await GroupReminder.create({
            groupJid: REMINDER_GROUP_JID,
            groupSubject: 'تذكيرات',
            creatorPhone: senderPhone || 'ميديا باير',
            reminderText: reminderText,
            targetEmployeeName: 'خدمة العملاء / الميديا باير',
            remindAt: remindAtUTC,
            status: 'pending',
            UserId: userId
        });

        console.log(`✅ [Sponsored Ads] Created reminder #${newReminder.id} for ${expiryDateStr} at 10:00 AM Cairo`);

        // 2. إرسال تأكيد فوري وموجز في جروب (تذكيرات)
        const confirmMsg = `✅ *تم تسجيل إعلان جديد وجدولة التذكير:*\n\n` +
            `👤 *العميل:* ${parsed.client}\n` +
            `⏱️ *المدة:* ${parsed.duration} أيام${parsed.budget ? `\n💰 *الميزانية:* ${parsed.budget} ج` : ''}\n` +
            `📅 *تاريخ الانتهاء:* ${expiryDayName} (${expiryDateStr})\n` +
            `🔔 *موعد التذكير:* صباح يوم الانتهاء الساعة 10:00 ص.\n\n` +
            `💡 _سيتم إرسال تذكير منفصل للعميل صباح يوم الانتهاء لوضع إيموجي ✅ عند المتابعة والتجديد._`;

        await sock.sendMessage(REMINDER_GROUP_JID, { text: confirmMsg }).catch(err => {
            console.error('❌ Error sending confirmation to reminders group:', err.message);
        });

        // 3. وضع تفاعل إيموجي ✅ على الرسالة في جروب اعلانات ممولة لتأكيد التسجيل
        if (typeof sock.sendMessage === 'function') {
            await sock.sendMessage(remoteJid, {
                react: { text: '✅', key: msg.key }
            }).catch(() => {});
        }

        return true;
    } catch (err) {
        console.error('❌ [Sponsored Ads] Error processing ad reminder:', err);
        return false;
    }
}
