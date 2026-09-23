import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { notifyControlGroup } from '../controllers/botController.js';

/**
 * إنشاء إشعار جديد وإرساله عبر Socket.IO إذا توفر
 */
export const createNotification = async ({ type, title, message, targetUserId, customerId, ownerId, io }) => {
    try {
        const notification = await Notification.create({
            type,
            title,
            message,
            targetUserId,
            CustomerId: customerId || null,
            UserId: ownerId
        });

        // إرسال الإشعار فورياً للمستخدم عبر Socket.IO إذا تم توفير 'io'
        if (io) {
            const dataToSend = {
                id: notification.id,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                isRead: notification.isRead,
                createdAt: notification.createdAt,
                CustomerId: notification.CustomerId
            };
            io.to(`user_${targetUserId}`).emit('notification', dataToSend);
        }

        // إرسال Web Push للموظف في الخلفية (سواء كان المتصفح مفتوح أو مغلق من الموبايل أو الكمبيوتر)
        if (targetUserId) {
            import('./webPushService.js').then(({ sendPushToUser }) => {
                const isFollowUp = type === 'follow_up_due';
                const isAssign = type === 'customer_assigned';
                const isNote = type === 'customer_note';

                let notifTag = `notif-${notification.id}-${Date.now()}`;
                if (isFollowUp) {
                    notifTag = `followup-${customerId || Date.now()}-${Date.now()}`;
                } else if (isAssign) {
                    notifTag = `assign-${customerId || Date.now()}-${Date.now()}`;
                } else if (isNote) {
                    notifTag = `note-${customerId || Date.now()}-${Date.now()}`;
                }

                let vibratePattern = [200, 100, 200, 100, 200];
                if (isFollowUp) {
                    vibratePattern = [300, 150, 300, 150, 300, 150, 300];
                } else if (isAssign) {
                    vibratePattern = [400, 150, 400, 150, 400];
                } else if (isNote) {
                    vibratePattern = [250, 100, 250];
                }

                const pushPayload = {
                    title: title || (isFollowUp ? '⏰ موعد متابعة عميل الآن' : (isAssign ? '👤 عميل جديد - Bird CRM' : (isNote ? '📝 ملاحظة جديدة على العميل' : '🔔 إشعار جديد - Bird CRM'))),
                    body: message || 'وصلك إشعار جديد على النظام',
                    icon: '/bird_crm_logo.png',
                    badge: '/bird_crm_logo.png',
                    tag: notifTag,
                    renotify: true,
                    requireInteraction: true,
                    vibrate: vibratePattern,
                    data: {
                        url: customerId ? `/dashboard/livechat?customerId=${customerId}` : '/dashboard/notifications',
                        customerId: customerId || null,
                        notificationId: notification.id,
                        type: type || 'general'
                    }
                };
                sendPushToUser(targetUserId, pushPayload).catch(pushErr => {
                    console.error('⚠️ [NotificationService] Error sending Web Push:', pushErr.message);
                });
            }).catch(impErr => {
                console.error('⚠️ [NotificationService] Failed to import webPushService:', impErr.message);
            });
        }

        return notification;
    } catch (error) {
        console.error('Error in createNotification service:', error);
        return null;
    }
};

/**
 * تحديد إشعار محدد كمقروء للموظف
 */
export const markAsRead = async (notificationId, userId) => {
    try {
        const notification = await Notification.findOne({
            where: { id: notificationId, targetUserId: userId }
        });
        if (notification) {
            notification.isRead = true;
            await notification.save();
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error in markAsRead service:', error);
        return false;
    }
};

/**
 * تحديد جميع إشعارات الموظف كمقروءة
 */
export const markAllAsRead = async (userId) => {
    try {
        await Notification.update(
            { isRead: true },
            { where: { targetUserId: userId, isRead: false } }
        );
        return true;
    } catch (error) {
        console.error('Error in markAllAsRead service:', error);
        return false;
    }
};

/**
 * جلب عدد الإشعارات غير المقروءة لموظف معين
 */
export const getUnreadCount = async (userId) => {
    try {
        const count = await Notification.count({
            where: { targetUserId: userId, isRead: false }
        });
        return count;
    } catch (error) {
        console.error('Error in getUnreadCount service:', error);
        return 0;
    }
};

/**
 * جلب قائمة الإشعارات التاريخية مع Pagination
 */
export const getNotifications = async (userId, page = 1, limit = 10) => {
    try {
        const offset = (page - 1) * limit;
        const { count, rows } = await Notification.findAndCountAll({
            where: { targetUserId: userId },
            include: [
                {
                    model: Customer,
                    as: 'customer',
                    attributes: ['id', 'customerName', 'phoneNumber']
                }
            ],
            order: [['createdAt', 'DESC']],
            limit,
            offset
        });
        return {
            notifications: rows,
            totalCount: count,
            totalPages: Math.ceil(count / limit),
            page
        };
    } catch (error) {
        console.error('Error in getNotifications service:', error);
        return { notifications: [], totalCount: 0, totalPages: 0, page };
    }
};

/**
 * إرسال رسالة إشعارية نصية لجروب الواتساب المخصص للعمل
 */
export const sendWhatsAppNotification = async (ownerId, message, type = 'note_report') => {
    return await notifyControlGroup(ownerId, message, null, type);
};
