import { getSetting } from './settingsService.js';
import User from '../models/User.js';
import { sessions } from '../controllers/botController.js';

// In-Memory Anti-Ban Queue for Group WhatsApp Notifications
const notificationQueue = [];
let isProcessingQueue = false;
let lastSentTimestamp = 0;

/**
 * Generate a random human-like delay between minSeconds and maxSeconds in ms
 */
function getRandomAntiBanDelay(minSeconds = 5, maxSeconds = 9) {
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
                const targetDelay = getRandomAntiBanDelay(5, 9);
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
                await sock.sendMessage(targetGroupJid, { text: message });
                lastSentTimestamp = Date.now();
                console.log(`✅ [Anti-Ban Queue] Delivered "${type}" notification to Bird CRM Group (${targetGroupJid}). Remaining queued: ${notificationQueue.length}`);
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

