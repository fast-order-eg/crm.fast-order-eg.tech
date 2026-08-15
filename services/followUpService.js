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

export const checkPendingFollowUps = async (io) => {
    try {
        const now = new Date();
        const activeUsers = await User.findAll({ where: { auto_reply: true } });
        
        for (const user of activeUsers) {
            const userId = user.id;
            const sock = sessions.get(userId);
            if (!sock || !sock.user || sock.ws?.readyState !== 1) continue;

            // 1. [موقوف بطلب العميل] تحويل البوت التلقائي للعملاء الصامتين إلى حالة "first_follow_up" وجدولة المتابعة الأولى لهم
            // تم إيقافه لكي يتم تحويل العميل للمبيعات تلقائياً بدلاً من إدخاله في قائمة المتابعة التلقائية فور صمته.
            /*
            const noActionTimeout = await getSystemSetting('no_action_timeout', userId) || 10;
            const noActionCutoff = new Date(now.getTime() - (noActionTimeout * 60 * 1000));

            const silentCustomers = await Customer.findAll({
                where: {
                    UserId: userId,
                    status: { [Op.in]: ['new', 'in_funnel'] },
                    lastBotMessageAt: {
                        [Op.ne]: null,
                        [Op.lte]: noActionCutoff
                    },
                    [Op.or]: [
                        { lastReplyAt: null },
                        { lastReplyAt: { [Op.lt]: Sequelize.col('lastBotMessageAt') } }
                    ]
                }
            });

            for (const customer of silentCustomers) {
                try {
                    const oldStatus = customer.status;
                    customer.status = 'first_follow_up';
                    
                    // جدولة المتابعة الأولى بعد first_followup_delay
                    const firstFollowupDelay = await getSystemSetting('first_followup_delay', userId);
                    const firstFollowupDelayUnit = await getSystemSetting('first_followup_delay_unit', userId) || 'hours';
                    const firstFollowupDelayMs = firstFollowupDelayUnit === 'hours'
                        ? firstFollowupDelay * 60 * 60 * 1000
                        : firstFollowupDelay * 60 * 1000;
                    
                    customer.scheduledFollowUpAt = new Date(now.getTime() + firstFollowupDelayMs);
                    await customer.save();

                    await ChangeLog.create({
                        action: 'status_change',
                        description: `توقف العميل عن الرد. قام البوت بتحويل الحالة تلقائياً إلى "متابعة أولى" وجدولة رسالة المتابعة الأولى بعد مرور الوقت المحدد.`,
                        oldValue: oldStatus,
                        newValue: 'first_follow_up',
                        CustomerId: customer.id,
                        performedByUserId: userId,
                        UserId: userId
                    });

                    console.log(`[FollowUpService] Auto-moved silent customer ${customer.phoneNumber} to first_follow_up and scheduled first follow-up.`);
                } catch (err) {
                    console.error(`Error auto-moving silent customer ${customer.id} to first_follow_up:`, err);
                }
            }
            */

            // 2. معالجة المتابعات المجدولة للعملاء في حالة "first_follow_up"
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
                    // التحقق هل تم إرسال المتابعة الأولى للعميل من قبل
                    const firstFollowupSent = await FollowUp.findOne({
                        where: {
                            CustomerId: customer.id,
                            type: 'first',
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
                        const shouldUseMetaTemplate = firstFollowupType === 'meta_template' || isWindowExpired;

                        let customerFirstMsg = firstFollowupMessage;
                        if (shouldUseMetaTemplate) {
                            const templateName = await getSystemSetting('first_followup_template_name', userId) || 'followup_3days';
                            customerFirstMsg = `[قالب ميتا المعتمد: ${templateName}]`;
                            console.log(`[FollowUpService Smart Fallback] Customer ${customer.phoneNumber} activity was ${hoursPassed.toFixed(1)}h ago (Window Expired: ${isWindowExpired}). Auto-switching to Meta Template: ${templateName}`);
                            await sendMetaMessage(customer.phoneNumber, '', {
                                template: {
                                    name: templateName,
                                    language: { code: 'ar' },
                                    components: [
                                        {
                                            type: 'body',
                                            parameters: [
                                                { type: 'text', text: customer.customerName || 'عميلنا العزيز' }
                                            ]
                                        }
                                    ]
                                }
                            });
                        } else {
                            if (firstFollowupType === 'dynamic') {
                                customerFirstMsg = await generateDynamicFollowUpMessage(customer.id, userId, firstFollowupMessage);
                            }
                            await sock.sendMessage(customer.remoteJid, { text: customerFirstMsg });
                        }

                        await Message.create({
                            UserId: userId,
                            remoteJid: customer.remoteJid,
                            role: 'model',
                            content: customerFirstMsg,
                            status: 'sent'
                        });

                        // إرجاع المحادثة تلقائياً للبوت
                        await Conversation.update(
                            { is_handoff: false },
                            { where: { UserId: userId, remoteJid: customer.remoteJid } }
                        );

                        // تسجيل المتابعة الأولى في السجل
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
                        const finalFollowupDelay = await getSystemSetting('final_followup_delay', userId);
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
                            description: `حان موعد المتابعة الأولى. تم إرسال المتابعة بنجاح (${shouldUseMetaTemplate ? 'قالب ميتا أوتوماتيك لمرور >24س' : 'رسالة نصية'}) وتغيير الحالة إلى "متابعة نهائية".`,
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

                        console.log(`[FollowUpService] Sent scheduled first follow-up to ${customer.phoneNumber}`);
                    } else {
                        // --- إرسال المتابعة النهائية ---
                        const finalFollowupMessage = await getSystemSetting('final_followup_message', userId);
                        const finalFollowupType = await getSystemSetting('final_followup_type', userId) || 'static';
                        const shouldUseMetaTemplateFinal = finalFollowupType === 'meta_template' || isWindowExpired;

                        let customerFinalMsg = finalFollowupMessage;
                        if (shouldUseMetaTemplateFinal) {
                            const templateName = await getSystemSetting('final_followup_template_name', userId) || 'followup_3days';
                            customerFinalMsg = `[قالب ميتا المعتمد: ${templateName}]`;
                            console.log(`[FollowUpService Smart Fallback Final] Customer ${customer.phoneNumber} activity was ${hoursPassed.toFixed(1)}h ago (Window Expired: ${isWindowExpired}). Auto-switching to Meta Template: ${templateName}`);
                            await sendMetaMessage(customer.phoneNumber, '', {
                                template: {
                                    name: templateName,
                                    language: { code: 'ar' },
                                    components: [
                                        {
                                            type: 'body',
                                            parameters: [
                                                { type: 'text', text: customer.customerName || 'عميلنا العزيز' }
                                            ]
                                        }
                                    ]
                                }
                            });
                        } else {
                            if (finalFollowupType === 'dynamic') {
                                customerFinalMsg = await generateDynamicFollowUpMessage(customer.id, userId, finalFollowupMessage);
                            }
                            await sock.sendMessage(customer.remoteJid, { text: customerFinalMsg });
                        }

                        await Message.create({
                            UserId: userId,
                            remoteJid: customer.remoteJid,
                            role: 'model',
                            content: customerFinalMsg,
                            status: 'sent'
                        });

                        // إرجاع المحادثة تلقائياً للبوت
                        await Conversation.update(
                            { is_handoff: false },
                            { where: { UserId: userId, remoteJid: customer.remoteJid } }
                        );

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
                            description: `حان موعد المتابعة النهائية. تم إرسال رسالة العرض وتغيير الحالة إلى "متابعة نهائية".`,
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

                        console.log(`[FollowUpService] Sent scheduled final follow-up to ${customer.phoneNumber}`);
                    }
                } catch (err) {
                    console.error(`Error processing scheduled follow-up for customer ${customer.id}:`, err);
                }
            }

            // 3. انتهاء المهلة (Expired/Not Interested)
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
 * دالة لفحص المتابعات المجدولة يدوياً بواسطة موظف المبيعات
 */
export const checkScheduledFollowUps = async (io) => {
    try {
        const now = new Date();
        const pendingFollowUps = await FollowUp.findAll({
            where: {
                type: 'scheduled',
                status: 'pending',
                scheduledAt: { [Op.lte]: now }
            },
            include: [{ model: Customer, as: 'customer' }]
        });

        for (const followup of pendingFollowUps) {
            const userId = followup.UserId;
            const sock = sessions.get(userId);
            if (!sock || !followup.customer) continue;

            try {
                // إرسال رسالة المتابعة المجدولة
                if (followup.message) {
                    await sock.sendMessage(followup.customer.remoteJid, { text: followup.message });
                    
                    await Message.create({
                        UserId: userId,
                        remoteJid: followup.customer.remoteJid,
                        role: 'model',
                        content: followup.message,
                        status: 'sent'
                    });

                    // إرجاع المحادثة تلقائياً للبوت
                    await Conversation.update(
                        { is_handoff: false },
                        { where: { UserId: userId, remoteJid: followup.customer.remoteJid } }
                    );
                }

                followup.status = 'sent';
                followup.sentAt = new Date();
                await followup.save();

                await ChangeLog.create({
                    action: 'follow_up',
                    description: `تم إرسال رسالة المتابعة المجدولة يدوياً للعميل.`,
                    CustomerId: followup.customer.id,
                    performedByUserId: userId,
                    UserId: userId
                });

                await notificationService.createNotification({
                    type: 'follow_up_sent',
                    title: 'متابعة مجدولة',
                    message: `تم إرسال رسالة المتابعة المجدولة للعميل: ${followup.customer.customerName || followup.customer.phoneNumber}`,
                    targetUserId: followup.customer.assignedToUserId || userId,
                    customerId: followup.customer.id,
                    ownerId: userId,
                    io
                });

                console.log(`[FollowUpService] Sent scheduled follow-up for customer ${followup.customer.phoneNumber}`);
            } catch (err) {
                console.error(`Error sending scheduled follow-up ID ${followup.id}:`, err);
            }
        }
    } catch (error) {
        console.error('Error in checkScheduledFollowUps:', error);
    }
};
