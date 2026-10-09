import { getSetting } from './settingsService.js';
import User from '../models/User.js';
import { sessions } from '../controllers/botController.js';

// In-Memory Anti-Ban Queue for Group WhatsApp Notifications
const notificationQueue = [];
let isProcessingQueue = false;
let lastSentTimestamp = 0;

/**
 * Generate a random human-like delay between minSeconds and maxSeconds in ms
 * Increased to 15-30s to simulate natural intervals between notifications
 */
function getRandomAntiBanDelay(minSeconds = 15, maxSeconds = 30) {
    const seconds = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    return seconds * 1000;
}

/**
 * Queue Consumer: Sends group notifications with strict Anti-Ban pacing & guaranteed intervals
 */
async function processNotificationQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (notificationQueue.length > 0) {
        const item = notificationQueue.shift();
        const { userId, message, type, resolve } = item;

        try {
            // 1. Enforce strict anti-ban delay from the LAST sent message (even if previous queue emptied)
            if (lastSentTimestamp > 0) {
                const targetDelay = getRandomAntiBanDelay(15, 30);
                const timeSinceLastSend = Date.now() - lastSentTimestamp;
                if (timeSinceLastSend < targetDelay) {
                    const waitMs = targetDelay - timeSinceLastSend;
                    console.log(`🛡️ [Anti-Ban Queue] Pacing: waiting ${(waitMs / 1000).toFixed(1)}s before sending next notification...`);
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }

            // 2. Locate active Baileys socket
            let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);
            if (!sock || !sock.user) {
                for (const [sKey, sVal] of sessions.entries()) {
                    if (sVal && sVal.user) {
                        sock = sVal;
                        console.log(`🔄 [Anti-Ban Queue] Using active Baileys session (User ${sKey}) for system notification.`);
                        break;
                    }
                }
            }

            if (!sock || !sock.user) {
                console.warn(`⚠️ [Anti-Ban Queue] Baileys socket not connected for User ${userId}. Dropping notification.`);
                if (resolve) resolve(false);
                continue;
            }

            // 3. Locate target group JID
            const userObj = await User.findByPk(userId);
            let targetGroupJid = userObj?.control_group_jid;

            if (!targetGroupJid) {
                // Check if any other user has control_group_jid
                const anyUserWithGroup = await User.findOne({ where: { control_group_jid: '120363428750785329@g.us' } });
                if (anyUserWithGroup && anyUserWithGroup.control_group_jid) {
                    targetGroupJid = anyUserWithGroup.control_group_jid;
                } else {
                    targetGroupJid = '120363428750785329@g.us';
                }
            }

            if (!targetGroupJid) {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    for (const groupId in groups) {
                        const group = groups[groupId];
                        if (group.subject && group.subject.toLowerCase() === 'bird crm') {
                            targetGroupJid = groupId;
                            await User.update({ control_group_jid: groupId }, { where: { id: userId } });
                            console.log(`✅ [Anti-Ban Queue] Auto-detected and saved Bird CRM group JID: ${groupId}`);
                            break;
                        }
                    }
                } catch (gErr) {
                    console.error('Error fetching Baileys control group:', gErr);
                }
            }

            if (targetGroupJid) {
                // 🛡️ Anti-Ban Human Simulation:
                // Step A: Announce presence as available
                try {
                    if (typeof sock.sendPresenceUpdate === 'function') {
                        await sock.sendPresenceUpdate('available', targetGroupJid).catch(() => {});
                    }
                } catch (pErr) {}

                // Step B: Human typing simulation ('composing') proportional to message length
                const textLen = (message || '').length;
                const typingDuration = Math.min(8000, Math.max(3000, Math.floor(textLen * 15) + Math.floor(Math.random() * 2000)));

                try {
                    if (typeof sock.sendPresenceUpdate === 'function') {
                        await sock.sendPresenceUpdate('composing', targetGroupJid).catch(() => {});
                        console.log(`✍️ [Anti-Ban Queue] Simulating human typing for ${(typingDuration / 1000).toFixed(1)}s in group...`);
                        await new Promise(r => setTimeout(r, typingDuration));
                        await sock.sendPresenceUpdate('paused', targetGroupJid).catch(() => {});
                    }
                } catch (tErr) {}

                // Step C: Append random invisible unicode zero-width space to randomize message hash
                const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
                const randomJitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
                const messageWithJitter = `${message}${randomJitter}`;

                // Step D: Send message
                await sock.sendMessage(targetGroupJid, { text: messageWithJitter });
                lastSentTimestamp = Date.now();
                console.log(`✅ [Anti-Ban Queue] Delivered "${type}" notification to Bird CRM Group (${targetGroupJid}). Remaining queued: ${notificationQueue.length}`);

                // Step E: Set presence to unavailable after short cooldown
                setTimeout(() => {
                    try {
                        if (typeof sock.sendPresenceUpdate === 'function') {
                            sock.sendPresenceUpdate('unavailable', targetGroupJid).catch(() => {});
                        }
                    } catch (e) {}
                }, 2000);

                if (resolve) resolve(true);
            } else {
                console.warn(`⚠️ [Anti-Ban Queue] Bird CRM Control Group not found on Baileys socket for User: ${userId}`);
                if (resolve) resolve(false);
            }
        } catch (err) {
            console.error(`❌ [Anti-Ban Queue] Error sending queued notification:`, err?.message || err);
            if (resolve) resolve(false);
        }
    }

    isProcessingQueue = false;
}

/**
 * Unified notification dispatcher with Anti-Ban Queue
 * Routes ALL system notifications, handoffs, inactivity summaries, and reports exclusively to the Bird CRM Control Group via Baileys
 */
export async function sendSystemNotification({ userId, assignedToUserId = null, message, type = 'general' }) {
    try {
        // إدارة الإشعارات: إيقاف إشعارات طلب التدخل وتدخل المبيعات والـ Auto-Handoff نهائياً حسب طلب العميل
        const isHandoffNotice = (message && (
            message.includes('طلب تدخل فريق المبيعات') ||
            message.includes('طلب تدخل بشري') ||
            message.includes('Auto-Handoff') ||
            message.includes('طلب تدخل') ||
            message.includes('تم تعيين عميل جديد')
        )) || type === 'handoff' || type === 'auto_handoff' || type === 'sales_handoff' || type === 'auto_assignment';

        if (isHandoffNotice) {
            console.log(`🔇 [NotificationDispatcher] Muted handoff/intervention WhatsApp group notification per user request.`);
            return false;
        }

        // حماية هامة: رسائل الملاحظات، ملخصات المحادثة، وتأكيدات الاشتراكات مسموح بها دائماً وتصل للجروب فوراً
        const isProtectedNotice = (message && (
            message.includes('تقرير إضافة/تحديث ملاحظات') ||
            message.includes('الملاحظات:') ||
            message.includes('تفعيل اشتراك') ||
            message.includes('ملخص محادثة منتهية')
        )) || type === 'note_report' || type === 'inactivity_summary' || type === 'payment_confirmed';

        // 1. Get Global Notification Settings
        const enableNotifications = await getSetting('enable_whatsapp_notifications', userId);
        if (enableNotifications === false || enableNotifications === 'false') {
            console.log('🔇 [NotificationDispatcher] WhatsApp notifications disabled globally in settings.');
            return false;
        }

        console.log(`🔔 [NotificationDispatcher] Enqueued notification type "${type}" for user ${userId}. (Total in queue: ${notificationQueue.length + 1})`);

        return new Promise((resolve) => {
            notificationQueue.push({
                userId,
                assignedToUserId,
                message,
                type,
                resolve
            });

            // Start queue processor in background
            processNotificationQueue().catch(err => {
                console.error('❌ [NotificationDispatcher] Fatal queue error:', err);
            });
        });
    } catch (err) {
        console.error('❌ [NotificationDispatcher] Global error:', err);
        return false;
    }
}

/**
 * توحيد ومعالجة رقم الهاتف وتحويله لمعرف واتساب صالح (@s.whatsapp.net)
 */
export function normalizePhoneToJid(rawPhone) {
    if (!rawPhone) return null;
    let digits = String(rawPhone).replace(/[^0-9]/g, '');
    if (!digits) return null;

    // أرقام مصر المحلية
    if (digits.length === 11 && digits.startsWith('01')) {
        digits = '2' + digits; // 01012345678 -> 201012345678
    } else if (digits.length === 10 && (digits.startsWith('10') || digits.startsWith('11') || digits.startsWith('12') || digits.startsWith('15'))) {
        digits = '20' + digits; // 1012345678 -> 201012345678
    }

    if (digits.length < 10) return null; // رقم قصير غير صالح
    return `${digits}@s.whatsapp.net`;
}

/**
 * إرسال إشعار واتساب مباشر للموظف على رقمه الشخصي من رقم Baileys المتصل
 * @param {Object} params
 * @param {number} [params.userId] - معرف المستخدم المالك
 * @param {number} [params.targetEmployeeId] - معرف الموظف المستهدف
 * @param {string} [params.customPhone] - رقم الهاتف المستهدف إن وجد مباشرة
 * @param {string} params.message - نص الرسالة
 */
export async function sendDirectEmployeeWhatsAppNotification({ userId, targetEmployeeId, customPhone, message }) {
    try {
        if (!message || !message.trim()) return false;

        let employeePhone = customPhone || null;
        let empName = '';

        if (!employeePhone && targetEmployeeId) {
            const employee = await User.findByPk(targetEmployeeId);
            if (employee) {
                empName = employee.fullName || employee.username;
                employeePhone = employee.phone || employee.notificationPhone;
            }
        }

        if (!employeePhone && userId) {
            const employee = await User.findByPk(userId);
            if (employee) {
                empName = employee.fullName || employee.username;
                employeePhone = employee.phone || employee.notificationPhone;
            }
        }

        const targetJid = normalizePhoneToJid(employeePhone);
        if (!targetJid) {
            console.warn(`[EmployeeNotify] ⚠️ No valid phone number found for employee (ID: ${targetEmployeeId || userId}, Name: ${empName || 'Unknown'})`);
            return false;
        }

        // البحث عن جلسة Baileys نشطة للإرسال
        let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);
        if (!sock || !sock.user) {
            for (const [sKey, sVal] of sessions.entries()) {
                if (sVal && sVal.user) {
                    sock = sVal;
                    break;
                }
            }
        }

        if (!sock || !sock.user) {
            console.warn(`[EmployeeNotify] ⚠️ No active Baileys session found to send message to employee (${targetJid})`);
            return false;
        }

        // محاكاة كتابة بشرية بسيطة قبل الإرسال لمنع أي شك من خوارزميات واتساب
        try {
            if (typeof sock.sendPresenceUpdate === 'function') {
                await sock.sendPresenceUpdate('composing', targetJid).catch(() => {});
                await new Promise(r => setTimeout(r, 1200));
                await sock.sendPresenceUpdate('paused', targetJid).catch(() => {});
            }
        } catch (pErr) {}

        await sock.sendMessage(targetJid, { text: message.trim() });
        console.log(`✅ [EmployeeNotify] Delivered direct WhatsApp notification to employee (${empName || targetJid}) at ${targetJid}`);
        return true;
    } catch (err) {
        console.error(`❌ [EmployeeNotify] Error delivering WhatsApp notification:`, err?.message || err);
        return false;
    }
}

