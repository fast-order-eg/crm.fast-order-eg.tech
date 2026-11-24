import { getSetting, setSetting } from './settingsService.js';

/**
 * Normalize phone numbers or WhatsApp JIDs into a canonical key for reliable blocklist matching.
 * Handles formats like: 01019957191, 1019957191, 201019957191, +201019957191, 201019957191@s.whatsapp.net
 */
export function normalizePhoneKey(input) {
    if (!input) return '';
    let raw = String(input).trim();
    if (raw.includes('@')) raw = raw.split('@')[0];

    // Preserve BSUID or @username identifiers if non-numeric
    if (raw.includes('.') || raw.startsWith('@')) {
        return raw.toLowerCase();
    }

    let digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return '';

    if (digits.startsWith('0020') && digits.length === 14) {
        digits = digits.substring(2);
    } else if (digits.length === 11 && digits.startsWith('01')) {
        digits = '2' + digits;
    } else if (digits.length === 10 && /^1[0125]/.test(digits)) {
        digits = '20' + digits;
    }

    return digits;
}

export async function getBlockedNumbersSet(userId = 3) {
    try {
        const list = await getSetting('blocked_whatsapp_numbers', userId);
        const arr = Array.isArray(list) ? list : [];
        const set = new Set();
        for (const item of arr) {
            const norm = normalizePhoneKey(item);
            if (norm) set.add(norm);
        }
        return set;
    } catch (err) {
        console.error('⚠️ [BlocklistService] Failed to read blocked_whatsapp_numbers:', err.message);
        return new Set();
    }
}

export function isMatchInBlockedSet(blockedSet, ...identifiers) {
    if (!blockedSet || blockedSet.size === 0) return false;
    for (const id of identifiers) {
        if (!id) continue;
        const norm = normalizePhoneKey(id);
        if (norm && blockedSet.has(norm)) return true;
    }
    return false;
}

export async function isNumberBlocked(userId = 3, ...identifiers) {
    const blockedSet = await getBlockedNumbersSet(userId);
    return isMatchInBlockedSet(blockedSet, ...identifiers);
}

export async function addBlockedNumber(rawPhone, userId = 3) {
    const norm = normalizePhoneKey(rawPhone);
    if (!norm) return false;
    const set = await getBlockedNumbersSet(userId);
    set.add(norm);
    await setSetting('blocked_whatsapp_numbers', Array.from(set), userId);
    return true;
}

export async function removeBlockedNumber(rawPhone, userId = 3) {
    const norm = normalizePhoneKey(rawPhone);
    if (!norm) return false;
    const set = await getBlockedNumbersSet(userId);
    set.delete(norm);
    await setSetting('blocked_whatsapp_numbers', Array.from(set), userId);
    return true;
}
