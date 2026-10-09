import { Op, Sequelize } from 'sequelize';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import ChangeLog from '../models/ChangeLog.js';
import FollowUp from '../models/FollowUp.js';
import Conversation from '../models/Conversation.js';
import { getSetting as getSystemSetting } from './settingsService.js';
import * as notificationService from './notificationService.js';
import { sessions, generateDynamicFollowUpMessage } from '../controllers/botController.js';
import { sendMetaMessage } from '../controllers/metaCloudController.js';
import { sendDirectEmployeeWhatsAppNotification } from './notificationDispatcher.js';

/**
 * استخراج ومعالجة رقم هاتف العميل ومعرف الواتساب بدقة
 */
export function resolveCustomerTarget(customer) {
    if (!customer) return { phone: null, jid: null };
    let phone = String(customer.phoneNumber || '').trim();
    let jid = customer.remoteJid || null;

    if (phone.startsWith('@')) {
        // حساب مستخدم يوزرنيم واتساب
        if (!jid) jid = `${phone}@s.whatsapp.net`;
        return { phone, jid };
    }

    const isBsuid = phone.includes('.');
    if (isBsuid) {
        if (!jid) jid = `${phone}@s.whatsapp.net`;
        return { phone, jid };
    }

    let digits = phone.replace(/[^0-9]/g, '');
    if (digits.length === 11 && digits.startsWith('01')) {
        digits = '2' + digits;
    } else if (digits.length === 10 && (digits.startsWith('10') || digits.startsWith('11') || digits.startsWith('12') || digits.startsWith('15'))) {
        digits = '20' + digits;
    }

    if (!digits && jid) {
        const rawJid = jid.split('@')[0];
        const jidDigits = rawJid.replace(/[^0-9]/g, '');
        if (jidDigits.length >= 8) digits = jidDigits;
        else digits = rawJid;
    }

    if (!jid && digits) {
        jid = `${digits}@s.whatsapp.net`;
    }

    return { phone: digits || phone, jid };
}

/**
 * إرسال رسائل المتابعة عبر Meta Cloud API مع التحقق من نافذة الـ 24 ساعة
 * وتسجيل الحالة بدقة وإظهار علامة الفشل أو التايم في اللايف شات
 */
export async function sendFollowUpMessage({
    customer,
    userId,
    content,
    templateName,
    isWindowExpired,
    followUpType = 'first',
    io
}) {
    const { phone: targetPhone, jid: targetJid } = resolveCustomerTarget(customer);

    if (!targetPhone || !targetJid) {
        console.error(`[FollowUpService] ❌ Missing phone/JID for customer ID: ${customer?.id}`);
        return { success: false, status: 'failed', error: 'رقم هاتف العميل غير متوفر أو غير صالح' };
    }

    const defaultTemplate = templateName || 'followup_3days_';
    // 🛑 حماية صارمة للفيزا: إذا انتهت نافذة الـ 24 ساعة، يُمنع إرسال قوالب ميتا المدفوعة نهائياً
    if (isWindowExpired) {
        console.log(`[FollowUpService] 🛑 Follow-up blocked for customer ${customer?.id} (${targetPhone}): 24h window expired. Visa charges prevented.`);
        return {
            success: false,
            status: 'window_expired',
            error: 'مرت 24 ساعة على آخر تفاعل للعميل. تم إيقاف الإرسال التلقائي لحماية الفيزا من رسوم القوالب.',
            windowExpired: true,
            targetJid,
            targetPhone
        };
    }

    let metaRes = null;
    let sentViaTemplate = false;
    let textToSend = content || '';

    // التحقق من توافر إعدادات Meta API الرسمية
    const isMetaAvailable = !!(process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID);

    if (isMetaAvailable) {
        // داخل نافذة الـ 24 ساعة: إرسال الرسالة النصية المباشرة مجاناً 100% بدون أي خصم من الفيزا
        console.log(`[FollowUpService] 📤 Sending direct FREE Meta text message to ${targetPhone} for customer ${customer.id} (Within 24h window)`);
        metaRes = await sendMetaMessage(targetPhone, textToSend);

        // إذا ردت ميتا بأن نافذة الـ 24 ساعة منتهية، ممنوع نهائياً الإرسال بالقالب المدفوع!
        if (!metaRes.success) {
            const errStr = typeof metaRes.error === 'object' ? JSON.stringify(metaRes.error) : String(metaRes.error || '');
            if (errStr.includes('131047') || errStr.includes('24 hours') || errStr.includes('Re-engagement')) {
                console.log(`[FollowUpService] 🛑 Meta reported 24h window closed for ${targetPhone}. Aborting template send to prevent Visa charges.`);
                return {
                    success: false,
                    status: 'window_expired',
                    error: 'نافذة الـ 24 ساعة مغلقة لدى ميتا. تم منع إرسال القالب المدفوع حفاظاً على الفيزا.',
                    windowExpired: true,
                    targetJid,
                    targetPhone
                };
            }
        }
    } else {
        // ممنوع إرسال أي رسائل للعملاء من البيلز لحماية الأرقام
        console.log(`[FollowUpService] 🛑 Meta API not available. Baileys is strictly disabled for customer followups.`);
        return {
            success: false,
            status: 'failed',
            error: 'خدمة ميتا غير متوفرة، وممنوع الإرسال للعملاء من رقم البيلز للحماية.',
            targetJid,
            targetPhone
        };
    }

    const isSuccess = !!(metaRes && metaRes.success);
    const messageId = isSuccess
        ? (metaRes?.data?.messages?.[0]?.id || `meta_${Date.now()}`)
        : `failed_${Date.now()}`;
    const status = isSuccess ? 'sent' : 'failed';
    const errorMsg = !isSuccess
        ? (typeof metaRes?.error === 'object' ? (metaRes.error.message || JSON.stringify(metaRes.error)) : String(metaRes?.error || 'فشل الإرسال عبر واتساب'))
        : null;

    // 1. تسجيل الرسالة في جدول Message بالحالة الحقيقية (sent أو failed)
    const savedMsg = await Message.create({
        UserId: userId,
        remoteJid: targetJid,
        role: 'model',
        content: textToSend,
        messageId: messageId,
        status: status
    });

    // 2. تحديث المحادثة في جدول Conversation
    await Conversation.update(
        {
            is_handoff: false,
            lastMessageText: textToSend,
            lastMessageAt: new Date()
        },
        { where: { UserId: userId, remoteJid: targetJid } }
    );

    // 3. إرسال الأحداث اللحظية للايف شات لتحديث الواجهة وإظهار العلامة
    if (io) {
        io.to(`user_${userId}`).emit('new_message', savedMsg);
        io.to(`user_${userId}`).emit('conversation_updated', {
            remoteJid: targetJid,
            lastMessage: textToSend,
            updatedAt: new Date(),
            is_handoff: false
        });
        if (!isSuccess) {
            io.to(`user_${userId}`).emit('message_status', {
                messageId: messageId,
                status: 'failed'
            });
        }
    }

    return {
        success: isSuccess,
        messageId,
        status,
        error: errorMsg,
        sentViaTemplate,
        targetJid,
        targetPhone
    };
}

/**
 * دالة فحص ومعالجة المتابعة الأولى والمتابعة النهائية
 */
export const checkPendingFollowUps = async (io) => {
    try {
        const now = new Date();
        const isMetaAvailable = !!(process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID);

        const activeUsers = await User.findAll({ where: { auto_reply: true } });
        
        for (const user of activeUsers) {
            const userId = user.id;
            const sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);
            const isMetaUser = isMetaAvailable || user.connection_status === 'meta_online' || user.connection_status === 'meta';

            // إذا لم يكن متصلاً بميتا ولا يوجد جلسة، تخطي فقط في حال انعدام الاثنين
            if (!sock && !isMetaUser) continue;

            // 1. معالجة المتابعات المجدولة للعملاء في حالة "first_follow_up" أو "final_follow_up"
            const scheduledCustomers = await Customer.findAll({
                where: {
                    UserId: userId,
                    status: {
                        [Op.in]: ['first_follow_up', 'final_follow_up']
                    },
                    scheduledFollowUpAt: {
                        [Op.ne]: null,
                        [Op.lte]: now
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                }
            });

            for (const customer of scheduledCustomers) {
                try {
                    // التحقق هل تم إرسال المتابعات للعميل من قبل
                    const firstFollowupSent = await FollowUp.findOne({
                        where: {
                            CustomerId: customer.id,
                            type: 'first',
                            status: 'sent'
                        }
                    });

                    const finalFollowupSent = await FollowUp.findOne({
                        where: {
                            CustomerId: customer.id,
                            type: 'final',
                            status: 'sent'
                        }
                    });

                    // حساب ساعات الانقضاء على آخر تفاعل من العميل
                    const lastCustomerActivity = customer.lastReplyAt || customer.updatedAt || customer.firstContactAt || now;
                    const hoursPassed = (now.getTime() - new Date(lastCustomerActivity).getTime()) / (1000 * 60 * 60);
                    const isWindowExpired = hoursPassed >= 24;

                    if (customer.status === 'first_follow_up' && !firstFollowupSent) {
                        if (isWindowExpired) {
                            // 🛑 مرت 24 ساعة: إيقاف الإرسال التلقائي لحماية الفيزا وتنبيه الموظف هاتفياً
                            console.log(`[FollowUpService] 🛑 First follow-up skipped for customer ${customer.phoneNumber} (Window expired: ${hoursPassed.toFixed(1)}h). Visa charges prevented.`);

                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'first',
                                status: 'expired',
                                message: 'تم إيقاف المتابعة الأولى التلقائية لمرور أكثر من 24 ساعة لحماية الفيزا من الرسوم.',
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            customer.scheduledFollowUpAt = null;
                            await customer.save();

                            await ChangeLog.create({
                                action: 'follow_up_skipped',
                                description: `مرت 24 ساعة (${hoursPassed.toFixed(1)} ساعة) على آخر تفاعل للعميل. تم إيقاف إرسال المتابعة الأولى التلقائية لحماية الفيزا من خصم رسوم القوالب، والمطلوب التواصل معه هاتفياً.`,
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'follow_up_due',
                                title: `📞 متابعة أولى مطلوبة: ${customer.customerName || customer.phoneNumber}`,
                                message: `مرت 24 ساعة على العميل "${customer.customerName || customer.phoneNumber}". تم إيقاف رسالة الواتساب التلقائية لتوفير الرسوم، يرجى التواصل معه هاتفياً الآن.`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            continue;
                        }

                        // --- إرسال المتابعة الأولى مجاناً داخل الـ 24 ساعة ---
                        const firstFollowupMessage = await getSystemSetting('first_followup_message', userId);
                        const firstFollowupType = await getSystemSetting('first_followup_type', userId) || 'static';
                        const templateName = await getSystemSetting('first_followup_template_name', userId) || 'followup_3days_';

                        let customerFirstMsg = firstFollowupMessage || 'يا هلا بيك يا فندم! 🌸 حابين نطمن عليك.. هل جربت تفتح متجرك وتشوف لوحة التحكم، ولا وقفت معاك أي خطوة؟ لو محتاج نساعدك ونرفعلك أول منتجاتك ونربط البيكسل مجاناً، عرفنا وإحنا معاك خطوة بخطوة 🚀';
                        if (firstFollowupType === 'dynamic' && !isWindowExpired) {
                            try {
                                customerFirstMsg = await generateDynamicFollowUpMessage(customer.id, userId, firstFollowupMessage);
                            } catch (dynErr) {
                                console.error('[FollowUpService] Dynamic msg error, fallback to static:', dynErr.message);
                            }
                        }

                        const result = await sendFollowUpMessage({
                            customer,
                            userId,
                            content: customerFirstMsg,
                            templateName,
                            isWindowExpired,
                            followUpType: 'first',
                            io
                        });

                        if (result.success) {
                            // تسجيل المتابعة الأولى بنجاح
                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'first',
                                status: 'sent',
                                message: customerFirstMsg,
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            // جدولة المتابعة النهائية تلقائياً وتغيير الحالة
                            const finalFollowupDelay = await getSystemSetting('final_followup_delay', userId) || 24;
                            const finalFollowupDelayUnit = await getSystemSetting('final_followup_delay_unit', userId) || 'hours';
                            const finalFollowupDelayMs = finalFollowupDelayUnit === 'hours'
                                ? finalFollowupDelay * 60 * 60 * 1000
                                : finalFollowupDelay * 60 * 1000;

                            const oldStatus = customer.status;
                            customer.status = 'final_follow_up';
                            customer.scheduledFollowUpAt = new Date(now.getTime() + finalFollowupDelayMs);
                            customer.lastBotMessageAt = new Date();
                            await customer.save();

                            await ChangeLog.create({
                                action: 'follow_up',
                                description: `حان موعد المتابعة الأولى. تم إرسال المتابعة بنجاح عبر واتساب ميتا (${result.sentViaTemplate ? 'قالب ميتا' : 'رسالة نصية'}) وتغيير الحالة إلى "متابعة نهائية".`,
                                oldValue: oldStatus,
                                newValue: 'final_follow_up',
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'status_changed',
                                title: 'إرسال المتابعة الأولى',
                                message: `تم إرسال المتابعة الأولى للعميل: ${customer.customerName || customer.phoneNumber}`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            console.log(`[FollowUpService] ✅ Sent scheduled first follow-up to ${customer.phoneNumber}`);
                        } else {
                            // فشل الإرسال: تسجيل الفشل وإيقاف الجدولة المستمرة لتجنب التكرار كل دقيقة
                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'first',
                                status: 'failed',
                                message: customerFirstMsg,
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            customer.scheduledFollowUpAt = null;
                            await customer.save();

                            await ChangeLog.create({
                                action: 'follow_up_failed',
                                description: `⚠️ تعذر إرسال المتابعة الأولى للعميل عبر ميتا: ${result.error}. تظهر علامة فشل حمراء في الشات للمتابعة اليدوية.`,
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'follow_up_due',
                                title: '⚠️ فشل إرسال المتابعة الأولى',
                                message: `تعذر إرسال المتابعة الأولى للعميل "${customer.customerName || customer.phoneNumber}" عبر واتساب ميتا (${result.error}). يرجى التواصل معه يدوياً.`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            console.error(`[FollowUpService] ❌ Failed to send first follow-up to ${customer.phoneNumber}: ${result.error}`);
                        }
                    } else if (customer.status === 'final_follow_up' && !finalFollowupSent) {
                        if (isWindowExpired) {
                            // 🛑 مرت 24 ساعة: إيقاف الإرسال التلقائي لحماية الفيزا وتنبيه الموظف هاتفياً
                            console.log(`[FollowUpService] 🛑 Final follow-up skipped for customer ${customer.phoneNumber} (Window expired: ${hoursPassed.toFixed(1)}h). Visa charges prevented.`);

                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'final',
                                status: 'expired',
                                message: 'تم إيقاف المتابعة النهائية التلقائية لمرور أكثر من 24 ساعة لحماية الفيزا من الرسوم.',
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            customer.scheduledFollowUpAt = null;
                            await customer.save();

                            await ChangeLog.create({
                                action: 'follow_up_skipped',
                                description: `مرت 24 ساعة (${hoursPassed.toFixed(1)} ساعة) على آخر تفاعل للعميل. تم إيقاف إرسال المتابعة النهائية التلقائية لحماية الفيزا من خصم رسوم القوالب، والمطلوب التواصل معه هاتفياً.`,
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'follow_up_due',
                                title: `📞 متابعة نهائية مطلوبة: ${customer.customerName || customer.phoneNumber}`,
                                message: `حان موعد المتابعة النهائية للعميل "${customer.customerName || customer.phoneNumber}". تم إيقاف رسالة الواتساب التلقائية لحماية الفيزا، يرجى التواصل معه هاتفياً الآن.`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            continue;
                        }

                        // --- إرسال المتابعة النهائية مجاناً إذا كان داخل الـ 24 ساعة ---
                        const finalFollowupMessage = await getSystemSetting('final_followup_message', userId);
                        const finalFollowupType = await getSystemSetting('final_followup_type', userId) || 'static';
                        const templateName = await getSystemSetting('final_followup_template_name', userId) || 'followup_3days_';

                        let customerFinalMsg = finalFollowupMessage || 'مساء الخير يا فندم ✨ حابين نفكرك إن باقة الشراكة بالعمولة (2 جنيه بس ع الأوردر وبدون أي اشتراك شهري ثابت) متاحة لمتجرك مع فاست أوردر، وتقدر تبدأ تبيع لعملائك فوراً وتكبر مبيعاتك 🚀 حابب نبدأ سوا النهاردة؟';
                        if (finalFollowupType === 'dynamic' && !isWindowExpired) {
                            try {
                                customerFinalMsg = await generateDynamicFollowUpMessage(customer.id, userId, finalFollowupMessage);
                            } catch (dynErr) {
                                console.error('[FollowUpService] Dynamic final msg error, fallback to static:', dynErr.message);
                            }
                        }

                        const result = await sendFollowUpMessage({
                            customer,
                            userId,
                            content: customerFinalMsg,
                            templateName,
                            isWindowExpired,
                            followUpType: 'final',
                            io
                        });

                        if (result.success) {
                            // تسجيل المتابعة النهائية في السجل
                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'final',
                                status: 'sent',
                                message: customerFinalMsg,
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            const oldStatus = customer.status;
                            customer.status = 'final_follow_up';
                            customer.lastBotMessageAt = new Date();
                            customer.scheduledFollowUpAt = null; // تفريغ الحقل حتى لا يتم تكرار الإرسال
                            await customer.save();

                            await ChangeLog.create({
                                action: 'status_change',
                                description: `حان موعد المتابعة النهائية. تم إرسال رسالة العرض بنجاح عبر واتساب ميتا وتغيير الحالة إلى "متابعة نهائية".`,
                                oldValue: oldStatus,
                                newValue: 'final_follow_up',
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'status_changed',
                                title: 'إرسال المتابعة النهائية',
                                message: `تم إرسال المتابعة النهائية للعميل: ${customer.customerName || customer.phoneNumber}`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            console.log(`[FollowUpService] ✅ Sent scheduled final follow-up to ${customer.phoneNumber}`);
                        } else {
                            // فشل إرسال المتابعة النهائية
                            await FollowUp.create({
                                CustomerId: customer.id,
                                UserId: userId,
                                type: 'final',
                                status: 'failed',
                                message: customerFinalMsg,
                                scheduledAt: customer.scheduledFollowUpAt,
                                sentAt: new Date()
                            });

                            customer.scheduledFollowUpAt = null;
                            await customer.save();

                            await ChangeLog.create({
                                action: 'follow_up_failed',
                                description: `⚠️ تعذر إرسال المتابعة النهائية للعميل عبر ميتا: ${result.error}. تظهر علامة حمراء في الشات للمتابعة اليدوية.`,
                                CustomerId: customer.id,
                                performedByUserId: userId,
                                UserId: userId
                            });

                            await notificationService.createNotification({
                                type: 'follow_up_due',
                                title: '⚠️ فشل إرسال المتابعة النهائية',
                                message: `تعذر إرسال المتابعة النهائية للعميل "${customer.customerName || customer.phoneNumber}" عبر واتساب (${result.error}). يرجى التواصل هاتفياً معه.`,
                                targetUserId: customer.assignedToUserId || userId,
                                customerId: customer.id,
                                ownerId: userId,
                                io
                            });

                            console.error(`[FollowUpService] ❌ Failed to send final follow-up to ${customer.phoneNumber}: ${result.error}`);
                        }
                    } else if (firstFollowupSent && finalFollowupSent) {
                        // كلاهما تم إرساله بالفعل - تفريغ الموعد لمنع أي تكرار
                        customer.scheduledFollowUpAt = null;
                        await customer.save();
                    }
                } catch (err) {
                    console.error(`Error processing scheduled follow-up for customer ${customer.id}:`, err);
                }
            }

            // 2. انتهاء المهلة (Expired / Not Interested) بعد 48 ساعة من المتابعة النهائية
            const expireCutoff = new Date(now.getTime() - (48 * 60 * 60 * 1000));
            const expiredCustomers = await Customer.findAll({
                where: {
                    UserId: userId,
                    status: 'final_follow_up',
                    lastBotMessageAt: {
                        [Op.ne]: null,
                        [Op.lte]: expireCutoff
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                }
            });

            for (const customer of expiredCustomers) {
                try {
                    const oldStatus = customer.status;
                    customer.status = 'not_interested';
                    if (!customer.notes || customer.notes.trim() === '') {
                        customer.notes = 'غير مهتم';
                    }
                    await customer.save();

                    // تسجيل انتهاء المهلة في سجل المتابعات
                    await FollowUp.create({
                        CustomerId: customer.id,
                        UserId: userId,
                        type: 'no_action',
                        status: 'expired',
                        message: 'لم يتم الرد بعد المتابعة النهائية بـ 48 ساعة.',
                        scheduledAt: expireCutoff,
                        sentAt: new Date()
                    });

                    await ChangeLog.create({
                        action: 'status_change',
                        description: `تم إغلاق العميل تلقائياً وتغيير الحالة إلى "غير مهتم" لعدم الرد بعد المتابعة النهائية بـ 48 ساعة.`,
                        oldValue: oldStatus,
                        newValue: 'not_interested',
                        CustomerId: customer.id,
                        performedByUserId: userId,
                        UserId: userId
                    });

                    await notificationService.createNotification({
                        type: 'status_changed',
                        title: 'عميل غير مهتم تلقائي',
                        message: `تم تحويل العميل تلقائياً إلى غير مهتم لعدم الاستجابة: ${customer.customerName || customer.phoneNumber}`,
                        targetUserId: customer.assignedToUserId || userId,
                        customerId: customer.id,
                        ownerId: userId,
                        io
                    });

                    console.log(`[FollowUpService] Customer ${customer.phoneNumber} marked as not_interested automatically.`);
                } catch (err) {
                    console.error(`Error expiring customer ${customer.id}:`, err);
                }
            }
        }
    } catch (error) {
        console.error('Error in checkPendingFollowUps background job:', error);
    }
};

/**
 * دالة لفحص المتابعات المجدولة بموعد محدد (Scheduled Follow-up)
 * تجمع بين العملاء في حالة "scheduled_follow_up" وسجلات المتابعات المجدولة يدوياً
 */
export const checkScheduledFollowUps = async (io) => {
    try {
        const now = new Date();

        // 1. استخراج العملاء الذين لديهم حالة "scheduled_follow_up" وحان موعدهم
        const scheduledCustomers = await Customer.findAll({
            where: {
                status: 'scheduled_follow_up',
                scheduledFollowUpAt: {
                    [Op.ne]: null,
                    [Op.lte]: now
                }
            }
        });

        // 2. استخراج المتابعات المجدولة يدوياً من جدول FollowUp
        const pendingFollowUpRecords = await FollowUp.findAll({
            where: {
                type: 'scheduled',
                status: 'pending',
                scheduledAt: {
                    [Op.ne]: null,
                    [Op.lte]: now
                }
            },
            include: [{ model: Customer, as: 'customer' }]
        });

        // خريطة لتفادي تكرار معالجة نفس العميل في نفس الدقيقة
        const processedCustomerIds = new Set();

        // أ) معالجة سجلات FollowUp
        for (const followup of pendingFollowUpRecords) {
            if (!followup.customer) continue;
            const cust = followup.customer;
            processedCustomerIds.add(cust.id);

            const userId = followup.UserId || cust.UserId;
            const lastActivity = cust.lastReplyAt || cust.updatedAt || cust.firstContactAt || now;
            const hoursPassed = (now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60);
            const isWindowExpired = hoursPassed >= 24;

            if (isWindowExpired) {
                console.log(`[FollowUpService] 🛑 Scheduled followup for ${cust.phoneNumber} is outside 24h window (${hoursPassed.toFixed(1)}h). WhatsApp message skipped to protect Visa.`);

                followup.status = 'expired';
                followup.sentAt = new Date();
                await followup.save();

                cust.scheduledFollowUpAt = null;
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up_skipped',
                    description: `حان موعد المتابعة المجدولة للعميل. نظراً لمرور أكثر من 24 ساعة على تفاعله، تم إيقاف إرسال رسالة الواتساب الآلية لحماية الفيزا من الرسوم، والمطلوب التواصل هاتفياً.`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                // إرسال تنبيه الموعد الفوري للموظف للتواصل هاتفياً
                const targetUserIds = new Set();
                if (cust.assignedToUserId) targetUserIds.add(cust.assignedToUserId);
                if (userId) targetUserIds.add(userId);

                const notifTitle = `⏰ موعد متابعة العميل الآن: ${cust.customerName || cust.phoneNumber}`;
                const notesSnippet = cust.notes ? ` • ملاحظاتك: "${cust.notes}"` : '';
                const notifMessage = `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" (${cust.phoneNumber})${notesSnippet} (يرجى الاتصال به هاتفياً الآن - تم إيقاف رسالة الواتساب الآلية لتجاوز 24 ساعة وتوفير الرسوم)`;

                for (const tUid of targetUserIds) {
                    await notificationService.createNotification({
                        type: 'follow_up_due',
                        title: notifTitle,
                        message: notifMessage,
                        targetUserId: tUid,
                        customerId: cust.id,
                        ownerId: userId,
                        io
                    });
                }

                // 📲 إرسال تنبيه واتساب فوري حصراً على رقم الموظف المسؤول فقط
                try {
                    const waReminderMsg = `⏰ *تذكير: حان موعد متابعة العميل الآن!*\n\n` +
                        `👤 *العميل:* ${cust.customerName || 'عميل واتساب'}\n` +
                        `📱 *رقم العميل:* ${cust.phoneNumber}\n` +
                        (cust.notes ? `📝 *ملاحظاتك:* ${cust.notes}\n\n` : '\n') +
                        `📞 يرجى الاتصال به هاتفياً الآن.\n` +
                        `🔗 *رابط المحادثة:* https://crm.fast-order-eg.tech/dashboard/livechat?customerId=${cust.id}`;

                    const employeeToNotify = cust.assignedToUserId || userId;
                    await sendDirectEmployeeWhatsAppNotification({
                        userId,
                        targetEmployeeId: employeeToNotify,
                        message: waReminderMsg
                    });
                } catch (waErr) {
                    console.error('Error sending WhatsApp follow-up reminder to employee:', waErr);
                }
                continue;
            }

            const hasCustomMessage = followup.message && followup.message.trim().length > 0;

            // 🛑 إذا لم تكن هناك رسالة مخصصة مكتوبة يدوياً، فهذه جدولة متابعة داخلية لتذكير موظف السيلز فقط
            // ولا يجب إرسال أي رسائل عشوائية للعميل تدعي أننا نذكره بناء على طلبه!
            if (!hasCustomMessage) {
                console.log(`[FollowUpService] ⏰ Internal follow-up due for ${cust.phoneNumber}. Notifying sales rep.`);

                followup.status = 'sent';
                followup.sentAt = new Date();
                await followup.save();

                cust.scheduledFollowUpAt = null;
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up_alert',
                    description: `حان موعد المتابعة المجدولة للعميل. تم إرسال تنبيه للموظف المسؤول للمتابعة والتواصل هاتفياً.`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                const targetUserIds = new Set();
                if (cust.assignedToUserId) targetUserIds.add(cust.assignedToUserId);
                if (userId) targetUserIds.add(userId);

                const notifTitle = `⏰ موعد متابعة العميل الآن: ${cust.customerName || cust.phoneNumber}`;
                const notesSnippet = cust.notes ? ` • ملاحظاتك: "${cust.notes}"` : '';
                const notifMessage = `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" (${cust.phoneNumber})${notesSnippet} (يرجى الاتصال به هاتفياً أو متابعته الآن)`;

                for (const tUid of targetUserIds) {
                    await notificationService.createNotification({
                        type: 'follow_up_due',
                        title: notifTitle,
                        message: notifMessage,
                        targetUserId: tUid,
                        customerId: cust.id,
                        ownerId: userId,
                        io
                    });
                }

                // 📲 إرسال تنبيه واتساب فوري حصراً على رقم الموظف المسؤول فقط
                try {
                    const waReminderMsg = `⏰ *تذكير: حان موعد متابعة العميل الآن!*\n\n` +
                        `👤 *العميل:* ${cust.customerName || 'عميل واتساب'}\n` +
                        `📱 *رقم العميل:* ${cust.phoneNumber}\n` +
                        (cust.notes ? `📝 *ملاحظاتك السابقة:* ${cust.notes}\n\n` : '\n') +
                        `📞 يرجى الاتصال به هاتفياً أو متابعته الآن.\n` +
                        `🔗 *رابط المحادثة:* https://crm.fast-order-eg.tech/dashboard/livechat?customerId=${cust.id}`;

                    const employeeToNotify = cust.assignedToUserId || userId;
                    await sendDirectEmployeeWhatsAppNotification({
                        userId,
                        targetEmployeeId: employeeToNotify,
                        message: waReminderMsg
                    });
                } catch (waErr) {
                    console.error('Error sending WhatsApp follow-up reminder to employee:', waErr);
                }
                continue;
            }

            const textToSend = followup.message.trim();

            const result = await sendFollowUpMessage({
                customer: cust,
                userId,
                content: textToSend,
                templateName: 'followup_3days_',
                isWindowExpired,
                followUpType: 'scheduled',
                io
            });

            if (result.success) {
                followup.status = 'sent';
                followup.sentAt = new Date();
                await followup.save();

                cust.status = 'final_follow_up';
                cust.scheduledFollowUpAt = null;
                cust.lastBotMessageAt = new Date();
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up',
                    description: `حان موعد المتابعة المجدولة. تم إرسال رسالة التذكير بنجاح عبر واتساب ميتا (${result.sentViaTemplate ? 'قالب ميتا' : 'رسالة نصية'}).`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                // إرسال إشعار وتنبيه فوري للموظف المسؤول وصاحب البوت في نفس وقت وموعد المتابعة
                const targetUserIds = new Set();
                if (cust.assignedToUserId) targetUserIds.add(cust.assignedToUserId);
                if (userId) targetUserIds.add(userId);

                const notifTitle = `⏰ موعد متابعة العميل الآن: ${cust.customerName || cust.phoneNumber}`;
                const notesSnippet = cust.notes ? ` • ملاحظاتك: "${cust.notes}"` : '';
                const notifMessage = `حان الآن موعد متابعة العميل "${cust.customerName || 'عميل واتساب'}" (${cust.phoneNumber})${notesSnippet}`;

                for (const tUid of targetUserIds) {
                    await notificationService.createNotification({
                        type: 'follow_up_due',
                        title: notifTitle,
                        message: notifMessage,
                        targetUserId: tUid,
                        customerId: cust.id,
                        ownerId: userId,
                        io
                    });
                }

                console.log(`[FollowUpService] ✅ Sent scheduled follow-up for customer ${cust.phoneNumber}`);
            } else {
                followup.status = 'failed';
                followup.sentAt = new Date();
                await followup.save();

                cust.scheduledFollowUpAt = null; // إيقاف الجدولة لمنع التكرار
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up_failed',
                    description: `⚠️ حان موعد المتابعة المجدولة ولكن تعذر إرسال رسالة الواتساب عبر ميتا: ${result.error}. تظهر علامة حمراء في الشات للمتابعة اليدوية.`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                // إرسال تنبيه الموعد أيضاً للموظف للتواصل هاتفياً أو يدوياً
                const targetUserIds = new Set();
                if (cust.assignedToUserId) targetUserIds.add(cust.assignedToUserId);
                if (userId) targetUserIds.add(userId);

                const notifTitle = `⏰ موعد متابعة العميل الآن: ${cust.customerName || cust.phoneNumber}`;
                const notesSnippet = cust.notes ? ` • ملاحظاتك: "${cust.notes}"` : '';
                const notifMessage = `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" (${cust.phoneNumber})${notesSnippet} (تواصل معه هاتفياً الآن)`;

                for (const tUid of targetUserIds) {
                    await notificationService.createNotification({
                        type: 'follow_up_due',
                        title: notifTitle,
                        message: notifMessage,
                        targetUserId: tUid,
                        customerId: cust.id,
                        ownerId: userId,
                        io
                    });
                }

                console.error(`[FollowUpService] ❌ Failed scheduled follow-up for ${cust.phoneNumber}: ${result.error}`);
            }
        }

        // ب) معالجة باقي العملاء ذوي الحالة scheduled_follow_up (تنبيه داخلي فقط للسيلز للمتابعة الهاتفية)
        for (const cust of scheduledCustomers) {
            if (processedCustomerIds.has(cust.id)) continue;
            processedCustomerIds.add(cust.id);

            const userId = cust.UserId;
            console.log(`[FollowUpService] ⏰ Internal scheduled follow-up due for ${cust.phoneNumber}. Notifying sales rep.`);

            cust.scheduledFollowUpAt = null;
            await cust.save();

            await ChangeLog.create({
                action: 'follow_up_alert',
                description: `حان موعد المتابعة المجدولة للعميل. تم إرسال تنبيه للموظف المسؤول للمتابعة والتواصل معه هاتفياً.`,
                CustomerId: cust.id,
                performedByUserId: userId,
                UserId: userId
            });

            const targetUserIds = new Set();
            if (cust.assignedToUserId) targetUserIds.add(cust.assignedToUserId);
            if (userId) targetUserIds.add(userId);

            const notifTitle = `⏰ موعد متابعة العميل الآن: ${cust.customerName || cust.phoneNumber}`;
            const notesSnippet = cust.notes ? ` • ملاحظاتك: "${cust.notes}"` : '';
            const notifMessage = `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" (${cust.phoneNumber})${notesSnippet} (يرجى الاتصال به هاتفياً أو متابعته الآن)`;

            for (const tUid of targetUserIds) {
                await notificationService.createNotification({
                    type: 'follow_up_due',
                    title: notifTitle,
                    message: notifMessage,
                    targetUserId: tUid,
                    customerId: cust.id,
                    ownerId: userId,
                    io
                });
            }

            // 📲 إرسال تنبيه واتساب فوري حصراً على رقم الموظف المسؤول فقط
            try {
                const waReminderMsg = `⏰ *تذكير: حان موعد متابعة العميل الآن!*\n\n` +
                    `👤 *العميل:* ${cust.customerName || 'عميل واتساب'}\n` +
                    `📱 *رقم العميل:* ${cust.phoneNumber}\n` +
                    (cust.notes ? `📝 *ملاحظاتك السابقة:* ${cust.notes}\n\n` : '\n') +
                    `📞 يرجى الاتصال به هاتفياً أو متابعته الآن.\n` +
                    `🔗 *رابط المحادثة:* https://crm.fast-order-eg.tech/dashboard/livechat?customerId=${cust.id}`;

                const employeeToNotify = cust.assignedToUserId || userId;
                await sendDirectEmployeeWhatsAppNotification({
                    userId,
                    targetEmployeeId: employeeToNotify,
                    message: waReminderMsg
                });
            } catch (waErr) {
                console.error('Error sending WhatsApp follow-up reminder to employee:', waErr);
            }
        }
    } catch (error) {
        console.error('Error in checkScheduledFollowUps:', error);
    }
};
