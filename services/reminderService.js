import { Op } from 'sequelize';
import GroupReminder from '../models/GroupReminder.js';
import User from '../models/User.js';
import { getSetting, setSetting } from './settingsService.js';
import { sessions } from '../controllers/botController.js';
import { CONFIG } from '../config.js';
import { GoogleAuth } from 'google-auth-library';
import { normalizePhoneToJid } from './notificationDispatcher.js';

// بيانات الأدمن الأساسي الثابت
export const PRIMARY_ADMIN = {
    name: 'راضي',
    phone: '01092308465',
    isPrimary: true
};

export const PRIMARY_ADMIN_PHONE = PRIMARY_ADMIN.phone;

/**
 * تنظيف رقم الهاتف ومقارنته بمرونة (آخر 10 أرقام للموبايل المصري)
 */
export function normalizePhoneDigits(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.length >= 10) {
        return digits.slice(-10); // 1092308465
    }
    return digits;
}

/**
 * جلب قائمة المشرفين المصرح لهم (بالأسماء والأرقام)
 */
export async function getAuthorizedAdmins(userId = 3) {
    // الأدمن راضي دائماً في صدارة القائمة
    const list = [{ ...PRIMARY_ADMIN }];
    const seenDigits = new Set([normalizePhoneDigits(PRIMARY_ADMIN.phone)]);

    try {
        // 1. فحص قائمة المشرفين بالأسماء (reminder_authorized_admins)
        let customAdmins = await getSetting('reminder_authorized_admins', userId);
        if ((!customAdmins || (Array.isArray(customAdmins) && customAdmins.length === 0)) && userId !== 1) {
            customAdmins = await getSetting('reminder_authorized_admins', 1);
        }

        if (typeof customAdmins === 'string') {
            try {
                customAdmins = JSON.parse(customAdmins);
            } catch (_) {}
        }

        if (Array.isArray(customAdmins)) {
            for (const item of customAdmins) {
                if (item && item.phone) {
                    const norm = normalizePhoneDigits(item.phone);
                    if (norm && !seenDigits.has(norm)) {
                        seenDigits.add(norm);
                        list.push({
                            name: (item.name || '').trim() || (norm === normalizePhoneDigits('01012027705') ? 'خدمة العملاء' : 'مشرف معتمد'),
                            phone: item.phone,
                            isPrimary: false
                        });
                    }
                }
            }
        }

        // 2. فحص الأرقام المعتمدة الإضافية في reminder_authorized_phones لدعم البيانات السابقة
        let phoneSetting = await getSetting('reminder_authorized_phones', userId) || [];
        if ((!phoneSetting || (Array.isArray(phoneSetting) && phoneSetting.length === 0)) && userId !== 1) {
            phoneSetting = await getSetting('reminder_authorized_phones', 1) || [];
        }

        let phoneList = [];
        if (typeof phoneSetting === 'string') {
            phoneList = phoneSetting.split(',').map(p => p.trim());
        } else if (Array.isArray(phoneSetting)) {
            phoneList = phoneSetting;
        }

        for (const num of phoneList) {
            if (!num) continue;
            const norm = normalizePhoneDigits(num);
            if (norm && !seenDigits.has(norm)) {
                seenDigits.add(norm);
                const defaultName = norm === normalizePhoneDigits('01012027705') ? 'خدمة العملاء' : 'مشرف معتمد';
                list.push({
                    name: defaultName,
                    phone: num,
                    isPrimary: false
                });
            }
        }
    } catch (err) {
        console.error('Error fetching authorized admins:', err);
    }

    return list;
}

/**
 * التحقق هل الرقم يخص مشرفاً مصرحاً له بإدارة التذكيرات
 */
export async function isAuthorizedAdmin(senderPhone, userId = 3, participantJid = '') {
    const s = String(senderPhone || '');
    const p = String(participantJid || '');

    // 1. فحص مباشر للمعرفات الخاصة بالأدمن الأساسي راضي (هاتف أو LID أو JID)
    if (s.includes('01092308465') || s.includes('201092308465') || s.includes('243593499418829') ||
        p.includes('01092308465') || p.includes('201092308465') || p.includes('243593499418829')) {
        return true;
    }

    if (!senderPhone && !participantJid) return false;

    const cleanSender = normalizePhoneDigits(senderPhone);
    const cleanPart = normalizePhoneDigits(participantJid);
    const admins = await getAuthorizedAdmins(userId);
    return admins.some(a => {
        const adminNorm = normalizePhoneDigits(a.phone);
        return (cleanSender && adminNorm === cleanSender) || (cleanPart && adminNorm === cleanPart);
    });
}

/**
 * إضافة رقم مشرف جديد مع اسمه
 */
export async function addAuthorizedAdmin(rawPhone, adminName = '', userId = 3) {
    let clean = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (clean.length === 10 && (clean.startsWith('10') || clean.startsWith('11') || clean.startsWith('12') || clean.startsWith('15'))) {
        clean = '0' + clean;
    }
    if (clean.length < 10) return { success: false, message: '⚠️ رقم الهاتف غير صحيح. يرجى كتابة رقم مصري صالح.' };

    const cleanNorm = normalizePhoneDigits(clean);
    const currentAdmins = await getAuthorizedAdmins(userId);

    if (currentAdmins.some(a => normalizePhoneDigits(a.phone) === cleanNorm)) {
        const found = currentAdmins.find(a => normalizePhoneDigits(a.phone) === cleanNorm);
        return { success: false, message: `ℹ️ الرقم ${clean} مسجل بالفعل باسم *${found.name}*.` };
    }

    let finalName = (adminName || '').trim();
    if (!finalName) {
        finalName = cleanNorm === normalizePhoneDigits('01012027705') ? 'خدمة العملاء' : 'مشرف معتمد';
    }

    const customOnly = currentAdmins
        .filter(a => !a.isPrimary && normalizePhoneDigits(a.phone) !== normalizePhoneDigits(PRIMARY_ADMIN.phone))
        .map(a => ({ name: a.name, phone: a.phone, isPrimary: false }));

    const newAdmin = { name: finalName, phone: clean, isPrimary: false };
    customOnly.push(newAdmin);

    // الحفظ في قاعدة البيانات بصيغة JSON وبصيغة نصية أيضاً
    const phonesList = [PRIMARY_ADMIN.phone, ...customOnly.map(a => a.phone)].join(',');
    await setSetting('reminder_authorized_admins', JSON.stringify(customOnly), userId);
    await setSetting('reminder_authorized_phones', phonesList, userId);

    if (userId !== 1) {
        await setSetting('reminder_authorized_admins', JSON.stringify(customOnly), 1);
        await setSetting('reminder_authorized_phones', phonesList, 1);
    }

    return { 
        success: true, 
        message: `✅ تم إضافة المشرف *${finalName}* (${clean}) كمشرف معتمد في تذكيرات الجروب بنجاح.`,
        admin: newAdmin
    };
}

/**
 * حذف رقم مشرف
 */
export async function removeAuthorizedAdmin(rawPhone, userId = 3) {
    const cleanTarget = normalizePhoneDigits(rawPhone);
    if (cleanTarget === normalizePhoneDigits(PRIMARY_ADMIN.phone)) {
        return { success: false, message: '⚠️ لا يمكن حذف رقم الأدمن الرئيسي للنظام (راضي).' };
    }

    const currentAdmins = await getAuthorizedAdmins(userId);
    const existing = currentAdmins.find(a => normalizePhoneDigits(a.phone) === cleanTarget);
    if (!existing) {
        return { success: false, message: '⚠️ هذا الرقم غير موجود في قائمة المشرفين.' };
    }

    const filtered = currentAdmins
        .filter(a => !a.isPrimary && normalizePhoneDigits(a.phone) !== cleanTarget && normalizePhoneDigits(a.phone) !== normalizePhoneDigits(PRIMARY_ADMIN.phone))
        .map(a => ({ name: a.name, phone: a.phone, isPrimary: false }));

    const phonesList = [PRIMARY_ADMIN.phone, ...filtered.map(a => a.phone)].join(',');
    await setSetting('reminder_authorized_admins', JSON.stringify(filtered), userId);
    await setSetting('reminder_authorized_phones', phonesList, userId);

    if (userId !== 1) {
        await setSetting('reminder_authorized_admins', JSON.stringify(filtered), 1);
        await setSetting('reminder_authorized_phones', phonesList, 1);
    }

    return { 
        success: true, 
        message: `🗑️ تم إزالة المشرف *${existing.name}* (${existing.phone}) من قائمة المشرفين بنجاح.` 
    };
}

/**
 * تحويل تاريخ ووقت بتوقيت القاهرة (YYYY-MM-DD HH:mm:ss) إلى كائن Date بتوقيت UTC بدقة متناهية
 */
export function parseCairoDateTime(dateStr) {
    if (!dateStr) return null;
    const cleanStr = String(dateStr).replace('T', ' ').trim();
    const parts = cleanStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!parts) {
        return new Date(dateStr);
    }
    const [_, y, m, d, h, min, s] = parts.map(Number);
    const roughUtc = new Date(Date.UTC(y, m - 1, d, h, min, s || 0));
    
    // حساب الفارق الزمني لتوقيت القاهرة في هذه اللحظة المحددة (صيفي أو شتوي)
    const cairoStr = roughUtc.toLocaleString('en-US', { timeZone: 'Africa/Cairo', hour12: false });
    const utcStr = roughUtc.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const cairoTs = Date.parse(cairoStr + ' UTC');
    const utcTs = Date.parse(utcStr + ' UTC');
    const offsetMs = cairoTs - utcTs;
    
    return new Date(roughUtc.getTime() - offsetMs);
}

/**
 * الحصول على الوقت الحالي بتوقيت القاهرة
 */
function getCairoDateTimeInfo() {
    const now = new Date();
    // توقيت القاهرة UTC+3 (صيفي) أو UTC+2 (شتوي)
    const options = {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    const cairoDateStr = new Intl.DateTimeFormat('en-CA', options).format(now); // YYYY-MM-DD, HH:mm:ss
    const dayFormatter = new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long' });
    const dayName = dayFormatter.format(now);
    return { cairoDateStr, dayName, now };
}

/**
 * استدعاء نموذج الذكاء الاصطناعي Gemini Flash لتحليل العامية المصرية واستخراج الميعاد
 */
async function callGeminiToParseReminder(userText) {
    const { cairoDateStr, dayName } = getCairoDateTimeInfo();

    const systemPrompt = `أنت مساعد ذكي مخصص لتحليل أوامر التذكيرات بالعامية المصرية لجروب واتساب.
التاريخ والوقت الحالي في جمهورية مصر العربية (توقيت القاهرة) هو: "${cairoDateStr}".
اليوم هو: "${dayName}".

المطلوب منك تحليل رسالة المستخدم بدقة واستخراج البيانات التالية بتنسيق JSON حصرياً بدون أي نصوص خارج الـ JSON:
{
  "action": "create_reminder" | "list_reminders" | "cancel_reminder" | "add_admin" | "remove_admin" | "list_admins" | "help",
  "remindAt": "YYYY-MM-DD HH:mm:ss",
  "reminderText": "نص التذكير الصافي بعد استبعاد كلمات الأوامر والوقت واسم الموظف",
  "targetEmployee": "اسم الموظف المطلوب تذكيره لو ذكر بالاسم (مثل: ساهر، أحمد، محمد) أو null",
  "reminderId": 12,
  "adminPhone": "010xxxxxxxx",
  "adminName": "اسم المشرف إن وجد (مثل: خدمة العملاء)"
}

قواعد فهم العامية المصرية وحساب التوقيت:
1. "بكرة" أو "غدا": اليوم التالي بعد التاريخ الحالي.
2. "بعد بكرة": بعد يومين.
3. التوقيت التقريبي في مصر:
   - "الصبح": 10:00 صباحاً.
   - "الظهر": 13:00 ظهراً.
   - "العصر": 15:30 عصراً.
   - "المغرب": 18:00 مساءً.
   - "العشا" أو "بليل": 20:30 مساءً.
   - إذا حدد ساعة صريحة مثل "الساعة 4" أو "الساعة 5 م" أو "الساعة 10 بليل": احسبها بدقة بتنسيق 24 ساعة (16:00 أو 17:00 أو 22:00).
   - "كمان ساعة" أو "بعد نص ساعة": احسبها بالنسبة للتوقيت الحالي بالضبط.
   - إذا تم تحديد تاريخ فقط بدون تحديد ساعة معينة (مثال: بتاريخ 8-11-2026 أو يوم 15 نوفمبر): اجعل الساعة الافتراضية 10:00:00 صباحاً.
4. إذا طلب المستخدم عرض التذكيرات (مثال: "التذكيرات"، "المجدول"، "فكرني باللي جاي"): action = "list_reminders".
5. إذا طلب الإلغاء (مثال: "الغاء 5"، "احذف تذكير 3"): action = "cancel_reminder", reminderId = 5.
6. إذا طلب السماح لرقم أو إضافة مشرف (مثال: "اسمح للرقم دا 01012027705 لرقم خدمة العملاء"، "ضيف مشرف 01012027705 خدمة العملاء"): action = "add_admin", adminPhone = "01012027705", adminName = "خدمة العملاء".
7. إذا طلب حذف مشرف (مثال: "احذف المشرف 01012027705"): action = "remove_admin", adminPhone = "01012027705".
8. إذا طلب معرفة المشرفين أو المصرح لهم (مثال: "المشرفين"، "مين المشرفين"): action = "list_admins".
9. إذا لم يكن هناك تاريخ أو وقت محدد في أمر إنشاء التذكير، اجعل remindAt = null.`;

    const url = CONFIG.getVertexUrl();
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: userText }]
            }
        ],
        system_instruction: {
            parts: [{ text: systemPrompt }]
        },
        generationConfig: {
            temperature: 0.1,
            topP: 0.8,
            responseMimeType: "application/json"
        }
    };

    try {
        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'fast-order-505012-2adde4c0badf.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken.token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Vertex AI error: ${err}`);
        }

        const data = await response.json();
        const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text && !p.thought) || data.candidates?.[0]?.content?.parts?.[0];
        const rawJson = textPart?.text || '';
        const clean = rawJson.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
        return JSON.parse(clean);
    } catch (e) {
        console.error('Error in callGeminiToParseReminder:', e.message);
        return null;
    }
}

/**
 * تحليل رسالة التذكير عبر القواعد السريعة أولاً ثم الذكاء الاصطناعي
 */
export async function parseReminderInput(text) {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase();

    // 1. الأوامر الثابتة المباشرة السريعة (0ms latency)
    if (/^(التذكيرات|المجدول|كل التذكيرات|تذكيراتي|مجدول)$/i.test(raw)) {
        return { action: 'list_reminders' };
    }

    if (/^(المشرفين|المشرفين المعتمدين|قائمة المشرفين)$/i.test(raw)) {
        return { action: 'list_admins' };
    }

    if (/^(مساعدة|الأوامر|الاوامر|تعليمات)$/i.test(raw)) {
        return { action: 'help' };
    }

    const cancelMatch = raw.match(/^(?:الغاء|إلغاء|حذف|مسح)\s*(?:تذكير\s*)?#?(\d+)/i);
    if (cancelMatch) {
        return { action: 'cancel_reminder', reminderId: parseInt(cancelMatch[1], 10) };
    }

    const addAdminMatch = raw.match(/^(?:اضافة|إضافة|اسمح\s*(?:لـ?|للرقم\s*)?)\s*(?:مشرف\s*)?([0-9\+]+)(?:\s*(?:لـ?|باسم\s*)?([^\n\r]+))?/i);
    if (addAdminMatch) {
        return { 
            action: 'add_admin', 
            adminPhone: addAdminMatch[1],
            adminName: addAdminMatch[2] ? addAdminMatch[2].replace(/^(?:رقم|لرقم)\s*/i, '').trim() : null
        };
    }

    const removeAdminMatch = raw.match(/^(?:حذف|مسح|ازالة|إزالة)\s*مشرف\s*([0-9\+]+)/i);
    if (removeAdminMatch) {
        return { action: 'remove_admin', adminPhone: removeAdminMatch[1] };
    }

    // 2. تحليل الكلام الطبيعي بالعامية بواسطة Gemini Flash
    const aiResult = await callGeminiToParseReminder(raw);
    if (aiResult && aiResult.action) {
        return aiResult;
    }

    // Fallback: افتراض إنشاء تذكير لو تعذر فهم الذكاء الاصطناعي
    return {
        action: 'unknown',
        rawText: raw
    };
}

/**
 * البحث عن الموظف ومطابقته برقم هاتفه ومعرف الواتساب
 */
async function resolveTargetEmployee(employeeName, mentionedJids = []) {
    let targetName = employeeName || null;
    let targetPhone = null;
    let targetJid = null;

    // إذا كان الأدمن قد عمل منشن مباشر لشخص في الرسالة
    if (mentionedJids && mentionedJids.length > 0) {
        targetJid = mentionedJids[0];
        const rawDigits = targetJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
        targetPhone = rawDigits;
    }

    // إذا تم استخراج اسم الموظف ولم يتوفر JID
    if (targetName && !targetJid) {
        try {
            const cleanName = targetName.trim();
            const user = await User.findOne({
                where: {
                    [Op.or]: [
                        { fullName: { [Op.like]: `%${cleanName}%` } },
                        { username: { [Op.like]: `%${cleanName}%` } }
                    ]
                }
            });

            if (user && user.phone) {
                targetPhone = user.phone;
                targetJid = normalizePhoneToJid(user.phone);
                targetName = user.fullName || user.username;
            }
        } catch (e) {
            console.error('Error finding employee by name:', e);
        }
    }

    return { targetName, targetPhone, targetJid };
}

/**
 * تنسيق التاريخ والوقت باللغة العربية بتوقيت القاهرة
 */
export function formatArabicDateTime(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return 'غير محدد';
    
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false
    });
    
    const parts = formatter.formatToParts(dateObj);
    const getVal = (t) => parts.find(p => p.type === t)?.value;
    
    const year = parseInt(getVal('year'), 10);
    const month = parseInt(getVal('month'), 10) - 1;
    const day = parseInt(getVal('day'), 10);
    let hours = parseInt(getVal('hour'), 10);
    const minutes = getVal('minute');
    
    const dayFormatter = new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long' });
    const dayName = dayFormatter.format(dateObj);
    
    const monthsArabic = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    
    const ampm = hours >= 12 ? 'م' : 'ص';
    hours = hours % 12 || 12;

    return `${dayName} ${day} ${monthsArabic[month]} ${year} - الساعة ${hours}:${minutes} ${ampm}`;
}

/**
 * إرسال رسالة في الجروب مع محاكاة كتابة بشرية طبيعية لحماية الحساب من الحظر (Anti-Ban)
 */
async function sendGroupReply(sock, remoteJid, content) {
    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            // تأخير زمني بشري طبيعي يحاكي الكتابة اليدوية (من 1.2 ثانية إلى 2.2 ثانية)
            const typingDelay = 1200 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, typingDelay));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    return await sock.sendMessage(remoteJid, content);
}

/**
 * معالجة رسائل جروب التذكيرات
 */
export async function handleReminderGroupMessage({
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
    // 0. تجاهل الرسائل الفارغة تماماً لمنع أي رد غير مقصود
    if (!text || text.trim().length === 0) {
        return true;
    }

    // 1. التحقق من صلاحية الرقم المرسل (الأدمن والمشرفين المعتمدين فقط)
    const authorized = await isAuthorizedAdmin(senderPhone, userId, participantJid);
    if (!authorized) {
        console.log(`🔒 [Reminder Group] Message ignored from unauthorized participant: ${senderPhone || participantJid}`);
        return true; // تم التعامل معه بالتجاهل لحماية الجروب
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

    console.log(`👑 [Reminder Group] Authorized admin command from ${senderPhone}: "${text}"`);

    // استخراج المنشن إن وجد في الرسالة
    const mentionedJids = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    // 2. تحليل الأمر
    const parsed = await parseReminderInput(text);

    // 3. تنفيذ الإجراء
    switch (parsed.action) {
        case 'list_reminders': {
            const now = new Date();
            const reminders = await GroupReminder.findAll({
                where: {
                    status: 'pending',
                    remindAt: { [Op.gte]: now }
                },
                order: [['remindAt', 'ASC']],
                limit: 20
            });

            if (reminders.length === 0) {
                await sendGroupReply(sock, remoteJid, {
                    text: `📋 *لا توجد أي تذكيرات مجدولة حالياً.* 👍\n\nتقدر تضيف تذكير جديد في أي وقت بكتابة التذكير والميعاد بالعامية مباشرة.`
                });
                return true;
            }

            let reply = `📋 *قائمة التذكيرات المجدولة القادمة (${reminders.length}):*\n\n`;
            reminders.forEach((r, idx) => {
                const dateStr = formatArabicDateTime(new Date(r.remindAt));
                const empStr = r.targetEmployeeName ? ` (👤 مسؤول: ${r.targetEmployeeName})` : '';
                reply += `${idx + 1}️⃣ *[#${r.id}]* ${dateStr}\n📌 *الموضوع:* ${r.reminderText}${empStr}\n\n`;
            });
            reply += `➖➖➖➖➖➖➖➖\n💡 *للإلغاء:* اكتب "الغاء [رقم التذكير]" (مثال: الغاء ${reminders[0].id})`;

            await sendGroupReply(sock, remoteJid, { text: reply });
            return true;
        }

        case 'cancel_reminder': {
            if (!parsed.reminderId) {
                await sendGroupReply(sock, remoteJid, { text: `⚠️ يرجى تحديد رقم التذكير المراد إلغاؤه (مثال: الغاء 5)` });
                return true;
            }

            const reminder = await GroupReminder.findByPk(parsed.reminderId);
            if (!reminder || reminder.status !== 'pending') {
                await sendGroupReply(sock, remoteJid, { text: `⚠️ لم يتم العثور على تذكير معلق بالرقم #${parsed.reminderId}` });
                return true;
            }

            reminder.status = 'cancelled';
            await reminder.save();

            await sendGroupReply(sock, remoteJid, {
                text: `🗑️ *تم إلغاء التذكير رقم #${reminder.id} بنجاح.*\n📌 الموضوع الملغي: ${reminder.reminderText}`
            });
            return true;
        }

        case 'add_admin': {
            const res = await addAuthorizedAdmin(parsed.adminPhone, parsed.adminName, userId);
            await sendGroupReply(sock, remoteJid, { text: res.message });
            return true;
        }

        case 'remove_admin': {
            const res = await removeAuthorizedAdmin(parsed.adminPhone, userId);
            await sendGroupReply(sock, remoteJid, { text: res.message });
            return true;
        }

        case 'list_admins': {
            const admins = await getAuthorizedAdmins(userId);
            let reply = `👥 *قائمة المشرفين المصرح لهم بإدارة التذكيرات:*\n\n`;
            admins.forEach((a, i) => {
                const icon = a.isPrimary ? '👑' : '👤';
                const tag = a.isPrimary ? ' *(الأدمن الرئيسي)*' : ' *(مشرف معتمد)*';
                reply += `${i + 1}️⃣ ${icon} *${a.name}:* ${a.phone}${tag}\n`;
            });
            reply += `\n💡 لإضافة مشرف جديد: اكتب "اضافة مشرف 010xxxxxxxx [الاسم]"`;
            await sendGroupReply(sock, remoteJid, { text: reply });
            return true;
        }

        case 'help': {
            const helpText = `🤖 *دليل استخدام جروب التذكيرات:*\n\n` +
                `1️⃣ *لإضافة تذكير:* اكتب مباشرة بالعامية:\n` +
                `   - "فكرنا بكرة الساعة 3 نبعت تقرير للعميل أحمد"\n` +
                `   - "فكر ساهر يوم الأحد 10 الصبح اشتراك العميل كذا هيخلص"\n` +
                `   - "تذكير بعد ساعتين مكالمة مع فلان"\n\n` +
                `2️⃣ *لعرض التذكيرات القادمة:* اكتب "التذكيرات" أو "المجدول"\n\n` +
                `3️⃣ *لإلغاء تذكير:* اكتب "الغاء [الرقم]" (مثال: الغاء 3)\n\n` +
                `4️⃣ *لإدارة المشرفين:*\n` +
                `   - "المشرفين": لعرض المشرفين المصرح لهم\n` +
                `   - "اضافة مشرف 010xxxxxxxx [الاسم]"\n` +
                `   - "حذف مشرف 010xxxxxxxx"`;
            await sendGroupReply(sock, remoteJid, { text: helpText });
            return true;
        }

        case 'create_reminder': {
            if (!parsed.remindAt) {
                await sendGroupReply(sock, remoteJid, {
                    text: `⚠️ مقدرتش أحدد الميعاد بدقة من الرسالة.\nيرجى توضيح اليوم والساعة، مثلاً:\n"فكرنا بكرة الساعة 3 العصر نبعت تقرير للعميل أحمد" 👍`
                });
                return true;
            }

            const remindDate = parseCairoDateTime(parsed.remindAt);
            if (!remindDate || isNaN(remindDate.getTime()) || remindDate.getTime() <= Date.now()) {
                await sendGroupReply(sock, remoteJid, {
                    text: `⚠️ الموعد المحدد (${parsed.remindAt}) غير صالح أو وقت ماضي. يرجى تحديد موعد مستقبلي.`
                });
                return true;
            }

            // مطابقة الموظف المسؤول
            const { targetName, targetPhone, targetJid } = await resolveTargetEmployee(parsed.targetEmployee, mentionedJids);

            // حفظ التذكير في قاعدة البيانات
            const newReminder = await GroupReminder.create({
                groupJid: remoteJid,
                groupSubject: groupMetadata?.subject || 'تذكيرات',
                creatorPhone: senderPhone,
                reminderText: parsed.reminderText || text,
                targetEmployeeName: targetName,
                targetEmployeePhone: targetPhone,
                targetEmployeeJid: targetJid,
                remindAt: remindDate,
                status: 'pending',
                UserId: userId
            });

            const formattedDate = formatArabicDateTime(remindDate);

            // الرد بالتأكيد في الجروب
            const confirmMsg = `✅ *تم تسجيل التذكير بنجاح!*\n\n` +
                `📌 *الموضوع:* ${newReminder.reminderText}\n` +
                `🕒 *الموعد:* ${formattedDate}\n` +
                `👤 *المسؤول:* ${targetName || 'الجميع'}\n` +
                `🆔 *رقم التذكير:* #${newReminder.id}`;

            await sendGroupReply(sock, remoteJid, { text: confirmMsg });
            return true;
        }

        default: {
            await sendGroupReply(sock, remoteJid, {
                text: `لتسجيل تذكير تقدر تكتب بالعامية مباشرة، مثلاً:\n"فكرنا بكرة الساعة 3 نبعت تقرير للعميل كذا"\nأو اكتب "التذكيرات" لمعرفة المجدول 🌟`
            });
            return true;
        }
    }
}

/**
 * فحص وإرسال التذكيرات المستحقة (تستدعى دورياً عبر Cron كل دقيقة)
 */
export async function checkDueReminders(io) {
    try {
        const now = new Date();
        const dueReminders = await GroupReminder.findAll({
            where: {
                status: 'pending',
                remindAt: { [Op.lte]: now }
            },
            order: [['remindAt', 'ASC']],
            limit: 10
        });

        if (dueReminders.length === 0) return;

        console.log(`⏰ [Reminder Cron] Found ${dueReminders.length} due reminder(s) to dispatch.`);

        for (const reminder of dueReminders) {
            try {
                // البحث عن جلسة Baileys نشطة
                let sock = sessions.get(parseInt(reminder.UserId, 10)) || sessions.get(String(reminder.UserId)) || sessions.get(3);
                if (!sock || !sock.user) {
                    for (const [, sVal] of sessions.entries()) {
                        if (sVal && sVal.user) {
                            sock = sVal;
                            break;
                        }
                    }
                }

                if (!sock || !sock.user) {
                    console.warn(`⚠️ [Reminder Cron] No active Baileys socket found to send reminder #${reminder.id}. Postponing.`);
                    continue;
                }

                const mentions = [];
                let employeeSnippet = '👥 *المسؤول:* الجميع';

                if (reminder.targetEmployeeJid) {
                    mentions.push(reminder.targetEmployeeJid);
                    const cleanPhone = reminder.targetEmployeeJid.replace('@s.whatsapp.net', '');
                    const namePart = reminder.targetEmployeeName ? ` (${reminder.targetEmployeeName})` : '';
                    employeeSnippet = `👤 *المسؤول:* @${cleanPhone}${namePart}`;
                }

                const alertMsg = `⏰🔔 *تذكير هــام الآن!*\n\n` +
                    `📌 *الموضوع:* ${reminder.reminderText}\n` +
                    `🕒 *الموعد:* ${formatArabicDateTime(new Date(reminder.remindAt))}\n` +
                    `${employeeSnippet}\n\n` +
                    `يرجى التنفيذ فوراً وإفادتنا بالنتيجة ✨`;

                // محاكاة كتابة بشرية طبيعية قبل الإرسال (Anti-Ban Protection)
                try {
                    if (typeof sock.sendPresenceUpdate === 'function') {
                        await sock.sendPresenceUpdate('composing', reminder.groupJid).catch(() => {});
                        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
                        await sock.sendPresenceUpdate('paused', reminder.groupJid).catch(() => {});
                    }
                } catch (_) {}

                // إرسال الرسالة إلى الجروب مع تفعيل المنشن
                await sock.sendMessage(reminder.groupJid, {
                    text: alertMsg,
                    mentions: mentions
                });

                reminder.status = 'sent';
                reminder.sentAt = new Date();
                await reminder.save();

                console.log(`✅ [Reminder Cron] Successfully dispatched reminder #${reminder.id} to group ${reminder.groupJid}`);

                if (io) {
                    io.emit('reminder_sent', { reminderId: reminder.id });
                }

                // فاصل زمني آمن بين كل تذكير والآخر في حال وجود عدة تذكيرات في نفس الدقيقة
                await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
            } catch (itemErr) {
                console.error(`❌ [Reminder Cron] Error sending reminder #${reminder.id}:`, itemErr);
            }
        }
    } catch (err) {
        console.error('❌ [Reminder Cron] Global checkDueReminders error:', err);
    }
}
