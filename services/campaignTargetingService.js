import fetch from 'node-fetch';
import Message from '../models/Message.js';
import { cleanAnalysisText } from './facebookAnalysisService.js';
import { getAdsAuthorizedAdmins } from './adsReportService.js';
import { isStaffAuthorizedForFacebookAnalysis } from './facebookAnalysisService.js';

const CAMPAIGN_TARGETING_API_URL = 'https://einasouq.bird-ads.com/api/v1/merchant/campaign-targeting';
const CAMPAIGN_TARGETING_API_KEY = 'fastorder_merchant_secure_api_key_2026';

/**
 * Normalize phone number to standard Egyptian digits (e.g. '01092308465')
 */
export function normalizePhone(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.startsWith('20') && p.length === 12) {
        p = '0' + p.substring(2);
    } else if (p.length === 10 && (p.startsWith('10') || p.startsWith('11') || p.startsWith('12') || p.startsWith('15'))) {
        p = '0' + p;
    }
    return p;
}

/**
 * Check if the text is a plain "استهداف" prompt without ID (to show help/usage)
 */
export function isPlainTargetingCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return /^[\/\s]*(استهداف|targeting)[\/\s]*$/i.test(trimmed);
}

/**
 * Check if text contains a campaign targeting audit command
 */
export function isCampaignTargetingCommand(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();

    // 1. Exclude post-analysis alternative targeting triggers
    if (/^(btn_alternative_targeting|🎯\s*استهداف\s*بديل|استهداف\s*بديل|الاستهداف\s*البديل|بديل|زاوية\s*استهداف\s*تانية|زاوية\s*تانية|زاوية\s*تاني|زاوية\s*تانى|استهداف\s*تانى|استهداف\s*تاني|استهداف\s*اخر|استهداف\s*آخر|زاوية\s*بديلة|الزاوية\s*البديلة)$/i.test(trimmed)) {
        return false;
    }

    // 2. Must contain targeting keyword in Arabic or English
    const targetingKeyword = '(?:استهداف|فحص\\s*استهداف|تقييم\\s*استهداف|audit\\s*targeting|targeting)';
    const hasTargetingWord = new RegExp(`(?:^|[\\/\\s])${targetingKeyword}(?:[\\s\\d_]|$)`, 'i').test(trimmed);
    if (!hasTargetingWord) return false;

    // 3. Must contain a campaign ID (between 6 and 20 digits)
    const hasDigits = /\d{6,20}/.test(trimmed);
    return hasDigits;
}

/**
 * Extract Campaign ID from command text
 */
export function extractCampaignTargetingId(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();

    // 1. Prefix: "استهداف 120251570884260531" or "/استهداف 120251570884260531"
    const prefixMatch = trimmed.match(/(?:^|[\/\s])(?:استهداف|فحص\s*استهداف|تقييم\s*استهداف|targeting)\s*[:=\-]?\s*(\d{6,20})/i);
    if (prefixMatch && prefixMatch[1]) return prefixMatch[1];

    // 2. Suffix: "120251570884260531 استهداف"
    const suffixMatch = trimmed.match(/(\d{6,20})\s*(?:استهداف|targeting)/i);
    if (suffixMatch && suffixMatch[1]) return suffixMatch[1];

    // 3. Any 6-20 digit number in string containing targeting keyword
    if (/(?:استهداف|targeting)/i.test(trimmed)) {
        const anyDigits = trimmed.match(/(\d{6,20})/);
        if (anyDigits && anyDigits[1]) return anyDigits[1];
    }

    return null;
}

/**
 * Start continuous typing presence while long AI analysis runs
 */
function startContinuousComposing(sock, remoteJid) {
    if (!sock || !remoteJid || typeof sock.sendPresenceUpdate !== 'function') {
        return () => {};
    }
    try {
        sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
    } catch (_) {}

    const interval = setInterval(() => {
        try {
            sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        } catch (_) {}
    }, 3500);

    return () => {
        clearInterval(interval);
    };
}

/**
 * Send reply with human simulation, anti-ban jitter, and DB logging
 */
async function replyToTargetingChat(sock, remoteJid, text, userId = 3, io = null, isGroup = false) {
    if (!sock || !remoteJid || !text) return;

    const textLen = (text || '').length;

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('available', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // Human typing simulation (2.5s - 5.5s)
    const typingDuration = Math.min(5500, Math.max(2500, Math.floor(textLen * 8) + Math.floor(Math.random() * 1000) + 500));

    try {
        if (typeof sock.sendPresenceUpdate === 'function') {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            await new Promise(r => setTimeout(r, typingDuration));
            await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
    } catch (_) {}

    // Zero-width space jitter to break message hash
    const zeroWidthSpaces = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    const randomJitter = zeroWidthSpaces[Math.floor(Math.random() * zeroWidthSpaces.length)];
    const finalSendText = `${text}${randomJitter}`;

    try {
        await sock.sendMessage(remoteJid, { text: finalSendText });
    } catch (sendErr) {
        console.error('❌ [Campaign Targeting] WhatsApp send error:', sendErr.message);
    }

    setTimeout(() => {
        try {
            if (typeof sock.sendPresenceUpdate === 'function') {
                sock.sendPresenceUpdate('unavailable', remoteJid).catch(() => {});
            }
        } catch (_) {}
    }, 1500);

    // Save to DB and emit to socket if private chat
    if (!isGroup) {
        try {
            if (Message) {
                const savedMsg = await Message.create({
                    UserId: userId || 3,
                    remoteJid: remoteJid,
                    role: 'model',
                    content: text,
                    media_url: null,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                if (io && userId) {
                    io.to(`user_${userId}`).emit('new_message', savedMsg);
                }
            }
        } catch (dbErr) {
            console.error('⚠️ [Campaign Targeting] DB logging error:', dbErr.message);
        }
    }
}

/**
 * Call the Campaign Targeting API on einasouq
 */
export async function callCampaignTargetingApi(campaignId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 180 seconds

    try {
        console.log(`📡 [Campaign Targeting API] Calling endpoint for campaign ${campaignId}...`);
        const response = await fetch(CAMPAIGN_TARGETING_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CAMPAIGN_TARGETING_API_KEY
            },
            body: JSON.stringify({
                campaign_id: String(campaignId).trim()
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            let parsedErr = errText;
            try {
                const parsed = JSON.parse(errText);
                parsedErr = parsed.error || parsed.message || errText;
            } catch (_) {}
            return {
                success: false,
                error: parsedErr || `HTTP error ${response.status}`
            };
        }

        const data = await response.json();
        return data;
    } catch (err) {
        clearTimeout(timeout);
        console.error(`❌ [Campaign Targeting API Error]:`, err.message);
        return {
            success: false,
            error: err.name === 'AbortError' ? 'استغرق الفحص وقتاً طويلاً وتجاوز مهلة الانتظار (Timeout).' : err.message
        };
    }
}

/**
 * Check if the user is authorized to perform targeting audits
 */
export async function isAuthorizedForTargeting(phone, userId = 3) {
    if (!phone) return false;
    const clean = normalizePhone(phone);
    if (!clean) return false;

    // 1. Rady (01092308465)
    if (clean === '01092308465' || clean.endsWith('1092308465')) return true;

    // 2. Ads Authorized Admins
    try {
        const adsAdmins = await getAdsAuthorizedAdmins(userId);
        if (adsAdmins.some(a => normalizePhone(a.phone) === clean)) return true;
    } catch (_) {}

    // 3. Facebook Analysis Authorized Staff
    try {
        const staffCheck = await isStaffAuthorizedForFacebookAnalysis(phone, userId);
        if (staffCheck && staffCheck.isAuthorized) return true;
    } catch (_) {}

    return false;
}

/**
 * Handle incoming WhatsApp message for Campaign Targeting Audit
 */
export async function handleCampaignTargetingMessage({
    sock,
    remoteJid,
    phoneNumber,
    participantJid,
    text,
    userId = 3,
    io,
    isGroup = false
}) {
    if (!text || typeof text !== 'string') return { handled: false };
    const raw = text.trim();

    const isPlain = isPlainTargetingCommand(raw);
    const isCommand = isCampaignTargetingCommand(raw);

    if (!isPlain && !isCommand) {
        return { handled: false };
    }

    // Authorization verification
    const sender = phoneNumber || (participantJid ? participantJid.replace(/[^0-9]/g, '') : '');
    if (!isGroup) {
        const authorized = await isAuthorizedForTargeting(sender, userId);
        if (!authorized) {
            console.log(`🔒 [Campaign Targeting] Unauthorized private command from ${sender}`);
            return { handled: false };
        }
    }

    // If user wrote plain "استهداف" without campaign ID, send clear instruction
    if (isPlain) {
        const helpText = `ℹ️ يرجى كتابة رقم الحملة الإعلانية المراد فحص استهدافها 🎯\n\n💡 *أمثلة للاستخدام:*\n- \`استهداف 120251570884260531\`\n- \`120251570884260531 استهداف\`\n- \`/استهداف 120251570884260531\``;
        await replyToTargetingChat(sock, remoteJid, helpText, userId, io, isGroup);
        return { handled: true };
    }

    const campaignId = extractCampaignTargetingId(raw);
    if (!campaignId) {
        const helpText = `⚠️ لم يتم التعرف على رقم الحملة بشكل صحيح. يرجى التأكد من كتابة رقم الحملة المكون من أرقام.\n\n💡 مثال: \`استهداف 120251570884260531\``;
        await replyToTargetingChat(sock, remoteJid, helpText, userId, io, isGroup);
        return { handled: true };
    }

    console.log(`🎯 [Campaign Targeting] Starting audit for Campaign ID: ${campaignId} from ${sender}`);

    // Immediate acknowledgment
    const ackText = `🦅 جاري فحص وتدقيق استهداف الحملة (\`${campaignId}\`) بالذكاء الاصطناعي ومطابقته لمحتوى الإعلان وقاموس ميتا... ⏳`;
    await replyToTargetingChat(sock, remoteJid, ackText, userId, io, isGroup);

    // Keep typing presence active
    const stopComposing = startContinuousComposing(sock, remoteJid);

    try {
        const result = await callCampaignTargetingApi(campaignId);
        stopComposing();

        if (!result || !result.success) {
            const errDetail = result?.error || result?.message || 'تعذر استرجاع بيانات الحملة من خادم عين السوق.';
            console.error(`❌ [Campaign Targeting] API failed for ${campaignId}:`, errDetail);
            const errText = `⚠️ *تعذر فحص استهداف الحملة (\`${campaignId}\`):*\n\n📌 *السبب:* ${errDetail}`;
            await replyToTargetingChat(sock, remoteJid, errText, userId, io, isGroup);
            return { handled: true };
        }

        const parts = result.formatted_message_parts;
        if (!Array.isArray(parts) || parts.length === 0) {
            const emptyText = `⚠️ لم يتم العثور على تقرير استهداف لهذه الحملة (\`${campaignId}\`). تأكد من صحة رقم الحملة وأنها تحتوي على مجموعات إعلانية نشطة.`;
            await replyToTargetingChat(sock, remoteJid, emptyText, userId, io, isGroup);
            return { handled: true };
        }

        // Send all parts sequentially
        for (let i = 0; i < parts.length; i++) {
            const cleanedPart = cleanAnalysisText(parts[i]);
            await replyToTargetingChat(sock, remoteJid, cleanedPart, userId, io, isGroup);

            // Natural human pause between consecutive parts if more than one
            if (i < parts.length - 1) {
                const betweenDelay = 2500 + Math.floor(Math.random() * 1500);
                await new Promise(r => setTimeout(r, betweenDelay));
            }
        }

        return { handled: true };
    } catch (err) {
        stopComposing();
        console.error(`💥 [Campaign Targeting Exception] for ${campaignId}:`, err);
        const errText = `⚠️ حدث خطأ غير متوقع أثناء فحص استهداف الحملة (\`${campaignId}\`): ${err.message}`;
        await replyToTargetingChat(sock, remoteJid, errText, userId, io, isGroup);
        return { handled: true };
    }
}
