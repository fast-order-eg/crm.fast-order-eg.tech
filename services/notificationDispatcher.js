import { getSetting } from './settingsService.js';
import { sendMetaMessage } from '../controllers/metaCloudController.js';
import User from '../models/User.js';
import { sessions } from '../controllers/botController.js';

function toCleanWhatsAppPhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.startsWith('01') && digits.length === 11) {
        digits = '20' + digits.substring(1);
    }
    return digits;
}

/**
 * Unified notification dispatcher for Hybrid Mode
 * Routes ALL system notifications, handoffs, inactivity summaries, and reports exclusively to the Bird CRM Control Group via Baileys
 */
export async function sendSystemNotification({ userId, assignedToUserId = null, message, type = 'general' }) {
    try {
        console.log(`🔔 [NotificationDispatcher] Processing notification type "${type}" for owner ${userId}...`);

        // 1. Get Global Notification Settings
        const enableNotifications = await getSetting('enable_whatsapp_notifications', userId);
        if (enableNotifications === false || enableNotifications === 'false') {
            console.log('🔇 [NotificationDispatcher] WhatsApp notifications disabled globally in settings.');
            return false;
        }

        // 2. Dispatch Exclusively to Bird CRM Control Group via Baileys Socket
        let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);

        // Fallback: search any active Baileys socket in sessions
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
                try {
                    await sock.sendMessage(targetGroupJid, { text: message });
                    console.log(`✅ [NotificationDispatcher] Delivered notification to Bird CRM Control Group (${targetGroupJid})`);
                    return true;
                } catch (grpSendErr) {
                    console.error(`❌ [NotificationDispatcher] Failed to send to group ${targetGroupJid}:`, grpSendErr.message);
                }
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
