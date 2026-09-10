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
    let metaRes = null;
    let sentViaTemplate = false;
    let textToSend = content || '';

    // التحقق من توافر إعدادات Meta API الرسمية
    const isMetaAvailable = !!(process.env.META_ACCESS_TOKEN && process.env.META_PHONE_NUMBER_ID);

    if (isMetaAvailable) {
        if (isWindowExpired) {
            // خارج نافذة الـ 24 ساعة: واتساب ميتا يفرض إرسال قالب معتمد فقط
            sentViaTemplate = true;
            console.log(`[FollowUpService] 📤 Sending Meta Template "${defaultTemplate}" to ${targetPhone} for customer ${customer.id} (Window Expired: ${isWindowExpired})`);
            metaRes = await sendMetaMessage(targetPhone, '', {
                template: {
                    name: defaultTemplate,
                    language: { code: 'ar_EG' }
                }
            });
        } else {
            // داخل نافذة الـ 24 ساعة: إرسال الرسالة النصية المباشرة بكل حرية عبر ميتا
            console.log(`[FollowUpService] 📤 Sending direct Meta text message to ${targetPhone} for customer ${customer.id} (Within 24h window)`);
            metaRes = await sendMetaMessage(targetPhone, textToSend);

            // في حال ردت ميتا بأن نافذة الـ 24 ساعة منتهية، يتم التبديل التلقائي الفوري للقالب المعتمد
            if (!metaRes.success) {
                const errStr = typeof metaRes.error === 'object' ? JSON.stringify(metaRes.error) : String(metaRes.error || '');
                if (errStr.includes('131047') || errStr.includes('24 hours') || errStr.includes('Re-engagement')) {
                    console.log(`[FollowUpService] 🔄 Meta reported 24h window closed. Auto-falling back to template "${defaultTemplate}" for ${targetPhone}`);
                    sentViaTemplate = true;
                    metaRes = await sendMetaMessage(targetPhone, '', {
                        template: {
                            name: defaultTemplate,
                            language: { code: 'ar_EG' }
                        }
                    });
                }
            }
        }
    } else {
        // في حال عدم وجود ميتا إطلاقاً، محاولة الاتصال عبر Baileys إذا كان متاحاً
        const sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);
        if (sock && typeof sock.sendMessage === 'function') {
            try {
                const sentBaileys = await sock.sendMessage(targetJid, { text: textToSend });
                metaRes = {
                    success: true,
                    data: { messages: [{ id: sentBaileys?.key?.id || `baileys_${Date.now()}` }] }
                };
            } catch (sockErr) {
                metaRes = { success: false, error: sockErr.message };
            }
        } else {
            metaRes = { success: false, error: 'خدمة واتساب غير متصلة (رقم البليز مغلق وميتا غير مهيأ)' };
        }
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
                        // --- إرسال المتابعة الأولى ---
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
                        // --- إرسال المتابعة النهائية ---
                        const finalFollowupMessage = await getSystemSetting('final_followup_message', userId);
                        const finalFollowupType = await getSystemSetting('final_followup_type', userId) || 'static';
                        const templateName = await getSystemSetting('final_followup_template_name', userId) || 'followup_3days_';

                        let customerFinalMsg = finalFollowupMessage || 'مساء الخير يا فندم ✨ حبينا نفكرك إن عرض التجربة المجانية للمتجر لسه متاح لحضرتك، ومعاه تجهيز المتجر وربط بيكسل الإعلانات مجاناً من فريقنا لتجهيزك لأول مبيعات. حابب نبدأ سوا النهاردة؟ 🎁';
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

            const textToSend = followup.message || `أهلاً بك ${cust.customerName || ''}، بناءً على طلبك نذكرك بموعد المتابعة. هل أنت متاح الآن للحديث؟`;

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

                await notificationService.createNotification({
                    type: 'follow_up_due',
                    title: 'متابعة مجدولة',
                    message: `تم إرسال رسالة المتابعة المجدولة للعميل: ${cust.customerName || cust.phoneNumber}`,
                    targetUserId: cust.assignedToUserId || userId,
                    customerId: cust.id,
                    ownerId: userId,
                    io
                });

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

                await notificationService.createNotification({
                    type: 'follow_up_due',
                    title: '⚠️ فشل إرسال متابعة بموعد',
                    message: `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" ولكن تعذر إرسال رسالة الواتساب (${result.error}). يرجى التواصل هاتفياً معه الآن!`,
                    targetUserId: cust.assignedToUserId || userId,
                    customerId: cust.id,
                    ownerId: userId,
                    io
                });

                console.error(`[FollowUpService] ❌ Failed scheduled follow-up for ${cust.phoneNumber}: ${result.error}`);
            }
        }

        // ب) معالجة باقي العملاء ذوي الحالة scheduled_follow_up
        for (const cust of scheduledCustomers) {
            if (processedCustomerIds.has(cust.id)) continue;
            processedCustomerIds.add(cust.id);

            const userId = cust.UserId;
            const lastActivity = cust.lastReplyAt || cust.updatedAt || cust.firstContactAt || now;
            const hoursPassed = (now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60);
            const isWindowExpired = hoursPassed >= 24;

            const textToSend = `أهلاً بك ${cust.customerName || ''}، بناءً على طلبك نذكرك بموعد المتابعة. هل أنت متاح الآن للحديث؟`;

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
                await FollowUp.create({
                    CustomerId: cust.id,
                    UserId: userId,
                    type: 'scheduled',
                    status: 'sent',
                    message: textToSend,
                    scheduledAt: cust.scheduledFollowUpAt,
                    sentAt: new Date()
                });

                cust.status = 'final_follow_up';
                cust.scheduledFollowUpAt = null;
                cust.lastBotMessageAt = new Date();
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up',
                    description: `حان موعد المتابعة المجدولة للعميل. تم إرسال رسالة التذكير بنجاح عبر واتساب ميتا (${result.sentViaTemplate ? 'قالب ميتا' : 'رسالة نصية'}).`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                await notificationService.createNotification({
                    type: 'follow_up_due',
                    title: 'متابعة مجدولة',
                    message: `تم إرسال رسالة المتابعة المجدولة للعميل: ${cust.customerName || cust.phoneNumber}`,
                    targetUserId: cust.assignedToUserId || userId,
                    customerId: cust.id,
                    ownerId: userId,
                    io
                });

                console.log(`[FollowUpService] ✅ Sent scheduled follow-up for customer ${cust.phoneNumber}`);
            } else {
                await FollowUp.create({
                    CustomerId: cust.id,
                    UserId: userId,
                    type: 'scheduled',
                    status: 'failed',
                    message: textToSend,
                    scheduledAt: cust.scheduledFollowUpAt,
                    sentAt: new Date()
                });

                cust.scheduledFollowUpAt = null;
                await cust.save();

                await ChangeLog.create({
                    action: 'follow_up_failed',
                    description: `⚠️ حان موعد المتابعة المجدولة للعميل ولكن تعذر إرسال رسالة الواتساب عبر ميتا: ${result.error}. تظهر علامة حمراء في الشات للمتابعة اليدوية.`,
                    CustomerId: cust.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                await notificationService.createNotification({
                    type: 'follow_up_due',
                    title: '⚠️ فشل إرسال متابعة بموعد',
                    message: `حان موعد متابعة العميل "${cust.customerName || cust.phoneNumber}" ولكن تعذر إرسال رسالة الواتساب (${result.error}). يرجى التواصل هاتفياً معه الآن!`,
                    targetUserId: cust.assignedToUserId || userId,
                    customerId: cust.id,
                    ownerId: userId,
                    io
                });

                console.error(`[FollowUpService] ❌ Failed scheduled follow-up for ${cust.phoneNumber}: ${result.error}`);
            }
        }
    } catch (error) {
        console.error('Error in checkScheduledFollowUps:', error);
    }
};
