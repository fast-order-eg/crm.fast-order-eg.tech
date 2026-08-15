import { getSetting } from './settingsService.js';
import User from '../models/User.js';
import { sessions } from '../controllers/botController.js';

// In-Memory Anti-Ban Queue for Group WhatsApp Notifications
const notificationQueue = [];
let isProcessingQueue = false;

/**
 * Generate a random human-like delay between minSeconds and maxSeconds in ms
 */
function getRandomAntiBanDelay(minSeconds = 6, maxSeconds = 12) {
    const seconds = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    return seconds * 1000;
}

/**
 * Queue Consumer: Sends group notifications with strict Anti-Ban pacing
 */
async function processNotificationQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (notificationQueue.length > 0) {
        const item = notificationQueue.shift();
        const { sock, targetGroupJid, message, resolve, type } = item;

        try {
            if (sock && sock.user && targetGroupJid) {
                await sock.sendMessage(targetGroupJid, { text: message });
                console.log(`✅ [Anti-Ban Queue] Delivered "${type}" notification to Bird CRM Group (${targetGroupJid}). Remaining queued: ${notificationQueue.length}`);
                if (resolve) resolve(true);
            } else {
                console.warn(`⚠️ [Anti-Ban Queue] Socket or targetGroupJid missing for queued notification.`);
                if (resolve) resolve(false);
            }
        } catch (err) {
            console.error(`❌ [Anti-Ban Queue] Error sending queued notification:`, err?.message || err);
            if (item.resolve) item.resolve(false);
        }

        // Apply strict Anti-Ban delay before sending the next queued message
        if (notificationQueue.length > 0) {
            const delayMs = getRandomAntiBanDelay(6, 12);
            console.log(`🛡️ [Anti-Ban Queue] Waiting ${(delayMs / 1000).toFixed(1)}s before sending next group notification...`);
            await new Promise(r => setTimeout(r, delayMs));
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
        console.log(`🔔 [NotificationDispatcher] Queueing notification type "${type}" for owner ${userId}...`);

        // 1. Get Global Notification Settings
        const enableNotifications = await getSetting('enable_whatsapp_notifications', userId);
        if (enableNotifications === false || enableNotifications === 'false') {
            console.log('🔇 [NotificationDispatcher] WhatsApp notifications disabled globally in settings.');
            return false;
        }

        // 2. Locate active Baileys socket
        let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);

        if (!sock || !sock.user) {
            for (const [sKey, sVal] of sessions.entries()) {
                if (sVal && sVal.user) {
                    sock = sVal;
                    console.log(`🔄 [NotificationDispatcher] Using active Baileys session (User ${sKey}) for system notification.`);
                    break;
                }
            }
        }

        if (sock && sock.user) {
            const userObj = await User.findByPk(userId);
            let targetGroupJid = userObj?.control_group_jid;

            if (!targetGroupJid) {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    for (const groupId in groups) {
                        const group = groups[groupId];
                        if (group.subject && group.subject.toLowerCase() === 'bird crm') {
                            targetGroupJid = groupId;
                            await User.update({ control_group_jid: groupId }, { where: { id: userId } });
                            break;
                        }
                    }
                } catch (gErr) {
                    console.error('Error fetching Baileys control group:', gErr);
                }
            }

            if (targetGroupJid) {
                return new Promise((resolve) => {
                    notificationQueue.push({
                        sock,
                        targetGroupJid,
                        message,
                        type,
                        resolve
                    });
                    processNotificationQueue();
                });
            } else {
                console.log('⚠️ [NotificationDispatcher] Bird CRM Control Group not found on Baileys socket.');
            }
        } else {
            console.log('⚠️ [NotificationDispatcher] Baileys socket not connected for sending group notifications.');
        }

        return false;
    } catch (err) {
        console.error('❌ [NotificationDispatcher] Global error:', err);
        return false;
    }
}
