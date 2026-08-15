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
 * Unified notification dispatcher for Hybrid Mode (Baileys for Reports/Notifications + Meta Cloud API Fallback)
 * Handles Admin notifications + Sales Employee specific notifications + Control Group alerts
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

        const rawAdminPhone = await getSetting('admin_notification_phone', userId) || '201092308465';
        const adminPhone = toCleanWhatsAppPhone(rawAdminPhone);

        // Collect target WhatsApp numbers to receive this notification
        const targetPhones = new Set();

        // Admin always receives all notifications
        if (adminPhone) {
            targetPhones.add(adminPhone);
            console.log(`👑 [NotificationDispatcher] Included Admin phone: ${adminPhone}`);
        }

        // If assigned to a specific sales employee, also include the employee's notification/regular phone
        if (assignedToUserId) {
            try {
                const employee = await User.findByPk(assignedToUserId);
                if (employee && employee.enableNotifications !== false) {
                    const rawEmpPhone = employee.notificationPhone || employee.phone;
                    const empPhone = toCleanWhatsAppPhone(rawEmpPhone);
                    if (empPhone) {
                        targetPhones.add(empPhone);
                        console.log(`📱 [NotificationDispatcher] Included sales employee ${employee.fullName || employee.username} (${empPhone})`);
                    }
                }
            } catch (empErr) {
                console.error('Error fetching employee notification phone:', empErr);
            }
        }

        // 2. Hybrid Dispatcher Mode (Prefer Baileys for Internal Alerts & Reports to avoid 24h Meta limit)
        let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(userId);

        // Fallback: If target user's Baileys session is not active, try any connected Baileys session
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
            // === MODE A: Baileys Group & Direct (Free-Form 24/7 Internal Notifications) ===
            console.log(`🚀 [NotificationDispatcher] Sending via Baileys socket to Control Group & ${targetPhones.size} recipient(s)...`);

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
                    console.log(`✅ [NotificationDispatcher] Sent notification to Baileys Control Group (${targetGroupJid})`);
                } catch (grpSendErr) {
                    console.error(`❌ [NotificationDispatcher] Failed to send to group ${targetGroupJid}:`, grpSendErr.message);
                }
            }

            // Send direct 1-on-1 to Admin & Sales Employee via Baileys
            for (const phone of targetPhones) {
                const jid = `${phone}@s.whatsapp.net`;
                try {
                    await sock.sendMessage(jid, { text: message });
                    console.log(`✅ [NotificationDispatcher] Sent Baileys 1-on-1 notification to ${jid}`);
                } catch (bErr) {
                    console.error(`Failed sending Baileys 1-on-1 to ${jid}:`, bErr.message);
                }
            }
            return true;
        } else {
            // === MODE B: Meta WhatsApp Cloud API Fallback ===
            const isMetaActive = process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN;
            if (isMetaActive) {
                console.log(`🚀 [NotificationDispatcher] Baileys inactive. Fallback: Sending via Meta Cloud API to ${targetPhones.size} recipient(s)...`);
                for (const phone of targetPhones) {
                    try {
                        await sendMetaMessage(phone, message);
                        console.log(`✅ [NotificationDispatcher] Delivered Meta API notification to ${phone}`);
                    } catch (metaErr) {
                        console.error(`❌ [NotificationDispatcher] Failed to send to ${phone} via Meta API:`, metaErr.message);
                    }
                }
                return true;
            } else {
                console.log('⚠️ [NotificationDispatcher] Neither Baileys nor Meta API active for notifications.');
                return false;
            }
        }
    } catch (err) {
        console.error('❌ [NotificationDispatcher] Global error:', err);
        return false;
    }
}
