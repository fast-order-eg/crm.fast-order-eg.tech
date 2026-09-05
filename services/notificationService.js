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
