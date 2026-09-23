import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import PushSubscription from '../models/PushSubscription.js';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// مسار حفظ مفاتيح VAPID الدائمة
const vapidConfigPath = path.join(__dirname, '../config/vapid.json');

let vapidKeys = {
    publicKey: '',
    privateKey: '',
    subject: 'mailto:admin@fast-order-eg.tech'
};

try {
    if (fs.existsSync(vapidConfigPath)) {
        const rawData = fs.readFileSync(vapidConfigPath, 'utf8');
        vapidKeys = JSON.parse(rawData);
    } else {
        const generated = webpush.generateVAPIDKeys();
        vapidKeys = {
            publicKey: generated.publicKey,
            privateKey: generated.privateKey,
            subject: 'mailto:admin@fast-order-eg.tech'
        };
        fs.writeFileSync(vapidConfigPath, JSON.stringify(vapidKeys, null, 2), 'utf8');
        console.log('🔑 [WebPush] Generated new persistent VAPID keys saved to config/vapid.json');
    }
} catch (err) {
    console.error('❌ [WebPush] Error loading or generating VAPID keys:', err.message);
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
        subject: 'mailto:admin@fast-order-eg.tech'
    };
}

// تهيئة web-push بالمفاتيح
try {
    webpush.setVapidDetails(
        vapidKeys.subject,
        vapidKeys.publicKey,
        vapidKeys.privateKey
    );
    console.log('✅ [WebPush] VAPID details configured successfully.');
} catch (vapidErr) {
    console.error('❌ [WebPush] Failed to set VAPID details:', vapidErr.message);
}

/**
 * الحصول على المفتاح العام للمتصفح
 */
export const getVapidPublicKey = () => {
    return vapidKeys.publicKey;
};

/**
 * تحليل الـ User-Agent لمعرفة نوع الجهاز والمتصفح والنظام
 */
export const parseUserAgent = (userAgent = '') => {
    const ua = String(userAgent || '').toLowerCase();
    
    // نوع الجهاز
    let deviceType = 'desktop';
    if (/android|iphone|ipad|ipod|mobile|blackberry|iemobile|opera mini/i.test(ua)) {
        deviceType = /tablet|ipad/i.test(ua) ? 'tablet' : 'mobile';
    }

    // المتصفح
    let browser = 'متصفح غير معروف';
    if (/edg/i.test(ua)) {
        browser = 'Edge';
    } else if (/opr\//i.test(ua) || /opera/i.test(ua)) {
        browser = 'Opera';
    } else if (/samsungbrowser/i.test(ua)) {
        browser = 'Samsung Internet';
    } else if (/chrome|crios/i.test(ua)) {
        browser = 'Chrome';
    } else if (/firefox|fxios/i.test(ua)) {
        browser = 'Firefox';
    } else if (/safari/i.test(ua)) {
        browser = 'Safari';
    }

    // نظام التشغيل
    let os = 'نظام غير معروف';
    if (/windows/i.test(ua)) {
        os = 'Windows';
    } else if (/android/i.test(ua)) {
        os = 'Android';
    } else if (/iphone|ipad|ipod/i.test(ua)) {
        os = 'iOS';
    } else if (/mac os/i.test(ua)) {
        os = 'macOS';
    } else if (/linux/i.test(ua)) {
        os = 'Linux';
    }

    return { deviceType, browser, os };
};

/**
 * حفظ أو تجديد اشتراك Web Push لموظف
 */
export const saveSubscription = async ({ userId, subscription, userAgent }) => {
    try {
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            throw new Error('بيانات الاشتراك غير مكتملة');
        }

        const endpoint = subscription.endpoint;
        const endpointHash = crypto.createHash('md5').update(endpoint).digest('hex');
        const p256dh = subscription.keys.p256dh;
        const auth = subscription.keys.auth;

        const { deviceType, browser, os } = parseUserAgent(userAgent);

        const existing = await PushSubscription.findOne({ where: { endpointHash } });
        if (existing) {
            existing.UserId = userId;
            existing.p256dh = p256dh;
            existing.auth = auth;
            existing.deviceType = deviceType;
            existing.browser = browser;
            existing.os = os;
            existing.userAgent = userAgent || '';
            existing.isActive = true;
            existing.lastActiveAt = new Date();
            await existing.save();
            return existing;
        }

        const newSub = await PushSubscription.create({
            UserId: userId,
            endpoint,
            endpointHash,
            p256dh,
            auth,
            deviceType,
            browser,
            os,
            userAgent: userAgent || '',
            isActive: true,
            lastActiveAt: new Date()
        });

        return newSub;
    } catch (err) {
        console.error('❌ [WebPush] Error saving push subscription:', err);
        throw err;
    }
};

/**
 * إلغاء اشتراك Web Push
 */
export const removeSubscription = async ({ endpoint, userId }) => {
    try {
        if (!endpoint) return false;
        const endpointHash = crypto.createHash('md5').update(endpoint).digest('hex');
        const whereClause = { endpointHash };
        if (userId) whereClause.UserId = userId;

        const sub = await PushSubscription.findOne({ where: whereClause });
        if (sub) {
            sub.isActive = false;
            await sub.save();
            return true;
        }
        return false;
    } catch (err) {
        console.error('❌ [WebPush] Error removing subscription:', err);
        return false;
    }
};

/**
 * إرسال إشعار Web Push لموظف محدد على كل أجهزته المسجلة والنشطة
 */
export const sendPushToUser = async (userId, payload) => {
    try {
        const subscriptions = await PushSubscription.findAll({
            where: { UserId: userId, isActive: true }
        });

        if (!subscriptions || subscriptions.length === 0) {
            console.log(`ℹ️ [WebPush] No active push subscriptions for user ${userId}`);
            return { total: 0, sent: 0, failed: 0 };
        }

        console.log(`🚀 [WebPush] Sending push notification to user ${userId} across ${subscriptions.length} active device(s)...`);

        let sent = 0;
        let failed = 0;

        const pushData = JSON.stringify({
            title: payload.title || 'إشعار جديد - Bird CRM',
            body: payload.body || '',
            icon: payload.icon || '/bird_crm_logo.png',
            badge: payload.badge || '/bird_crm_logo.png',
            data: payload.data || { url: '/dashboard/notifications' },
            tag: payload.tag || `notif-${Date.now()}`,
            renotify: payload.renotify !== undefined ? payload.renotify : true,
            requireInteraction: payload.requireInteraction !== undefined ? payload.requireInteraction : true,
            vibrate: payload.vibrate || [200, 100, 200, 100, 200]
        });

        for (const sub of subscriptions) {
            const pushConfig = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            };

            try {
                await webpush.sendNotification(pushConfig, pushData);
                sub.lastNotifiedAt = new Date();
                await sub.save();
                sent++;
            } catch (error) {
                failed++;
                console.error(`⚠️ [WebPush] Failed sending push to device (id: ${sub.id}, browser: ${sub.browser}):`, error.statusCode || error.message);
                
                // إذا انتهت صلاحية الاشتراك أو تم إلغاؤه من المتصفح (404 أو 410)
                if (error.statusCode === 404 || error.statusCode === 410) {
                    console.log(`🗑️ [WebPush] Subscription expired or gone. Deactivating device (id: ${sub.id}).`);
                    sub.isActive = false;
                    await sub.save();
                }
            }
        }

        console.log(`✅ [WebPush] Push delivery summary for user ${userId}: ${sent} sent, ${failed} failed.`);
        return { total: subscriptions.length, sent, failed };
    } catch (err) {
        console.error('❌ [WebPush] Fatal error in sendPushToUser:', err);
        return { total: 0, sent: 0, failed: 0, error: err.message };
    }
};

/**
 * إرسال إشعار تجريبي لاشتراك محدد (بالـ id)
 */
export const sendPushToSubscriptionId = async (subscriptionId, payload) => {
    try {
        const sub = await PushSubscription.findByPk(subscriptionId);
        if (!sub) {
            throw new Error('الجهاز غير موجود');
        }

        const pushData = JSON.stringify({
            title: payload.title || '🔔 إشعار تجريبي من Bird CRM',
            body: payload.body || 'مبروك! جهازك متصل بنجاح وجاهز لاستقبال إشعارات العملاء الجدد في الخلفية.',
            icon: payload.icon || '/bird_crm_logo.png',
            badge: payload.badge || '/bird_crm_logo.png',
            data: payload.data || { url: '/dashboard/notifications' },
            tag: 'test-push',
            renotify: true,
            requireInteraction: true,
            vibrate: [200, 100, 200]
        });

        const pushConfig = {
            endpoint: sub.endpoint,
            keys: {
                p256dh: sub.p256dh,
                auth: sub.auth
            }
        };

        await webpush.sendNotification(pushConfig, pushData);
        sub.lastNotifiedAt = new Date();
        sub.isActive = true;
        await sub.save();

        return { success: true };
    } catch (error) {
        console.error('❌ [WebPush] Error sending test push to subscription:', error);
        if (error.statusCode === 404 || error.statusCode === 410) {
            await PushSubscription.update({ isActive: false }, { where: { id: subscriptionId } });
        }
        throw error;
    }
};

/**
 * جلب حالة إشعارات جميع الموظفين للمدير
 */
export const getEmployeesPushStatus = async (userRole = 'sales', currentUserId = null) => {
    try {
        // إذا كان الموظف سيلز، يجلب فقط بيانات نفسه
        const userWhere = userRole === 'sales' ? { id: currentUserId } : {};

        const users = await User.findAll({
            where: userWhere,
            attributes: ['id', 'username', 'fullName', 'role', 'phone', 'is_active'],
            include: [
                {
                    model: PushSubscription,
                    as: 'pushSubscriptions',
                    where: { isActive: true },
                    required: false,
                    attributes: ['id', 'deviceType', 'browser', 'os', 'lastActiveAt', 'lastNotifiedAt', 'createdAt']
                }
            ],
            order: [
                ['role', 'ASC'],
                ['fullName', 'ASC']
            ]
        });

        return users.map(u => {
            const subs = u.pushSubscriptions || [];
            return {
                id: u.id,
                username: u.username,
                fullName: u.fullName || u.username,
                role: u.role,
                phone: u.phone,
                isActiveUser: u.is_active,
                isPushActive: subs.length > 0,
                deviceCount: subs.length,
                devices: subs
            };
        });
    } catch (err) {
        console.error('❌ [WebPush] Error in getEmployeesPushStatus:', err);
        return [];
    }
};

export default {
    getVapidPublicKey,
    parseUserAgent,
    saveSubscription,
    removeSubscription,
    sendPushToUser,
    sendPushToSubscriptionId,
    getEmployeesPushStatus
};
