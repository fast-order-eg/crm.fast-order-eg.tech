import { CONFIG } from '../config.js';
import { GoogleAuth } from 'google-auth-library';
import User from '../models/User.js';
import Message from '../models/Message.js';
import path from 'path';

// Active in-memory sessions for staff members
// Key: clean staff phone (e.g. '01092308465') or LID
export const staffSessions = new Map();

// Configuration
const FAST_ORDER_API_URL = process.env.FAST_ORDER_INTERNAL_API_URL || 'https://fast-order-eg.tech/api/internal';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'fastorder_secret_api_key_2026';

/**
 * Send WhatsApp reply to staff AND permanently log it to the SQL Database (messages table)
 */
async function replyToStaff(sock, remoteJid, text, userId, io) {
    if (!sock || !remoteJid || !text) return;

    // 1. Send via WhatsApp socket
    try {
        await sock.sendMessage(remoteJid, { text });
    } catch (sendErr) {
        console.error('❌ [replyToStaff] WhatsApp send error:', sendErr.message);
    }

    // 2. Permanently log assistant reply to SQL DB
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
        console.error('⚠️ [replyToStaff] SQL logging error:', dbErr.message);
    }
}

/**
 * Normalize phone number to standard Egyptian digits
 */
export function normalizePhone(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.startsWith('20') && p.length === 12) {
        p = '0' + p.substring(2);
    }
    return p;
}

/**
 * Check if the sender is an authorized staff member.
 * Explicitly allows Rady (01092308465) and any active User with admin/super_admin/sales role.
 */
export async function isStaffAuthorized(phoneNumber) {
    const cleanPhone = normalizePhone(phoneNumber);
    if (!cleanPhone) return false;

    // 1. Explicit Whitelist: Rady (01092308465)
    if (cleanPhone === '01092308465' || cleanPhone.endsWith('1092308465')) {
        return { isAuthorized: true, name: 'أ. راضي', role: 'admin' };
    }

    // 2. Check Database for staff/admin user
    try {
        const user = await User.findOne({
            where: { phone: cleanPhone }
        });

        if (user && ['super_admin', 'admin', 'sales'].includes(user.role)) {
            return {
                isAuthorized: true,
                name: user.fullName || user.username,
                role: user.role,
                userId: user.id
            };
        }
    } catch (e) {
        console.error('Error checking staff authorization:', e.message);
    }

    return false;
}

/**
 * Get or create an active session for a staff member
 */
export function getStaffSession(sessionKey) {
    if (!staffSessions.has(sessionKey)) {
        staffSessions.set(sessionKey, {
            activeStore: null,       // { id, name, slug, store_url, categories, main_categories }
            currentDraft: null,      // { id, name, price_after, preview_url, ... }
            pendingMedia: [],        // [{ buffer, mimetype, filename }]
            pendingText: '',
            debounceTimer: null,
            state: 'IDLE'
        });
    }
    return staffSessions.get(sessionKey);
}

/**
 * Call Fast Order Internal API
 */
async function callFastOrderApi(endpoint, method = 'GET', body = null) {
    const url = `${FAST_ORDER_API_URL}${endpoint}`;
    const headers = {
        'X-Internal-Token': INTERNAL_API_KEY,
        'Accept': 'application/json',
    };

    const options = { method, headers };

    if (body) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({ success: false, message: 'Invalid JSON response from server' }));

    if (!res.ok) {
        throw new Error(data.message || `Fast Order API Error: ${res.status}`);
    }

    return data;
}

/**
 * Perform a Google/DuckDuckGo web search to gather product specifications if requested
 */
async function performProductWebSearch(query) {
    try {
        const cleanQuery = encodeURIComponent(query + ' مواصفات وسعر');
        const searchUrl = `https://html.duckduckgo.com/html/?q=${cleanQuery}`;
        const res = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!res.ok) return null;
        const html = await res.text();

        // Extract snippet texts from results
        const snippets = [];
        const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(html)) !== null && snippets.length < 4) {
            const cleanText = match[1].replace(/<[^>]+>/g, '').trim();
            if (cleanText) snippets.push(cleanText);
        }

        return snippets.join('\n');
    } catch (e) {
        console.error('Web search error:', e.message);
        return null;
    }
}

/**
 * Call Vertex AI Gemini 2.5 Flash
 */
async function callGemini(contents, systemInstruction, temperature = 0.1) {
    const credentialsPath = path.isAbsolute(CONFIG.GOOGLE_CREDENTIALS)
        ? CONFIG.GOOGLE_CREDENTIALS
        : path.join(process.cwd(), CONFIG.GOOGLE_CREDENTIALS);

    const auth = new GoogleAuth({
        keyFile: credentialsPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = CONFIG.getVertexUrl();

    const payload = {
        contents,
        systemInstruction: {
            parts: [{ text: systemInstruction }]
        },
        generationConfig: {
            temperature,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json'
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken.token}`
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Vertex AI Error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text && !p.thought) || data.candidates?.[0]?.content?.parts?.[0];
    const rawText = textPart?.text;
    if (!rawText) return null;

    try {
        return JSON.parse(rawText);
    } catch (e) {
        const clean = rawText.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
        return JSON.parse(clean);
    }
}

/**
 * Extract structured product details from text and images using Gemini 2.5 Flash
 */
export async function extractProductWithGemini(text, mediaList = [], webSearchContext = '') {
    const systemPrompt = `
أنت خبير محترف ومسؤول التجارة الإلكترونية لمنصة فاست اوردر (Fast Order).
مهمتك استخراج وتجهيز بيانات المنتج من نص البوست المرفق وصور الموديل بأعلى دقة تسويقية ممكنة وبصيغة JSON صالحة حصرياً.

الهيكل المطلوب لكائن JSON:
{
  "name": "اسم تجاري جذاب ومختصر للمنتج (مثال: كريم ترطيب جاردينيا، سويت شيرت ميلتون كابيشون)",
  "description": "الوصف التسويقي مقسم على أسطر مرتبة مع نقاط وإيموجي",
  "main_category": "القسم الرئيسي (مثال: مستحضرات تجميل، ملابس رجالي، ملابس حريمي، أحذية، عطور، أدوات منزلية، إلكترونيات، أغذية)",
  "category_name": "التصنيف الفرعي المناسب (مثال: كريمات ترطيب، سويت شيرت، تي شيرت، سيروم، قمصان)",
  "price_after": 0, // سعر البيع الأساسي بالجنيه (رقم صحيح بدون كسور أو كلمات)
  "price_before": 0, // السعر قبل الخصم إن وجد وإلا 0
  "sizes": ["M", "L"], // مصفوفة المقاسات للملابس والأحذية فقط، وإلا تترك فارغة []
  "colors": ["أسود", "أبيض"], // مصفوفة الألوان المتاحة للملابس، وإلا تترك فارغة []
  "custom_variants": [ // مصفوفة المتغيرات المخصصة للمنتجات التي لا تتبع مقاسات وألوان الملابس (مثل مستحضرات التجميل، العطور، العناية، الأغذية: مثل الحجم، الوزن، السعة)
    {
      "name": "الحجم", // أو "الوزن" أو "النوع"
      "values": ["30 جرام"]
    }
  ],
  "price_tiers": [ // مصفوفة الشرائح السعرية وعروض الكميات المذكورة في البوست (مثل: التلاتة بسعر 50 بدل 75، أو القطعتين بكذا)
    {
      "min_qty": 3,
      "price": 50
    }
  ],
  "stock": 100,
  "missing_fields": [] // فقط ["price"] إذا لم يذكر سعر البيع إطلاقاً
}

قواعد صارمة جداً:
1. 📝 تنسيق الوصف (description):
يجب أن يكون الوصف مقسماً على أسطر متعددة ومرتباً بإيموجي ونقاط واضحة باستخدام (\\n)، ولا يجوز دمجه في فقرة واحدة. الهيكل المطلوب:
نبذة تسويقية جذابة وموجزة عن المنتج.\\n\\n✨ *المميزات والمواصفات:*\\n- الميزة الأولى\\n- الميزة الثانية\\n- الميزة الثالثة\\n\\n🧪 *الخامة أو المكونات:*\\n- تفاصيل المكونات أو الخامة\\n\\n💡 *طريقة الاستخدام:* (إن وجدت).

2. 🏷️ عروض الكميات والشرائح السعرية (price_tiers):
إذا تضمن البوست عرض كميات (مثل: "عرض التلات قطع بسعر 50 جنيه بدل 75 جنيه" أو "القطعتين بـ 90 والتلاتة بـ 120"):
استخرجها فوراً في price_tiers مع وضع min_qty (عدد القطع المطلوب) و price (سعر العرض الإجمالي).

3. ⚖️ المتغيرات المخصصة (custom_variants):
إذا كان المنتج مستحضرات تجميل، عناية، عطور، أو أغذية ومذكور له حجم (مثل 30 جرام أو 50 مل) أو وزن (مثل 500 جرام أو كيلو) أو أشكال:
أنشئ متغيراً مخصصاً مناسباً (مثال name: "الحجم"، values: ["30 جرام"])، واجعل sizes فارغة [].

4. 📁 الأقسام الرئيسية والتصنيفات:
حدد القسم الرئيسي بدقة (main_category) والتصنيف الفرعي (category_name).
`;

    const parts = [];
    let promptText = `نص البوست المطلوب تحليله:\n${text || 'منتج جديد من الصور'}`;

    if (webSearchContext) {
        promptText += `\n\nنتائج ومعلومات بحث الإنترنت عن هذا المنتج:\n${webSearchContext}`;
    }

    parts.push({ text: promptText });

    for (const media of mediaList) {
        if (media.buffer) {
            parts.push({
                inline_data: {
                    mime_type: media.mimetype || 'image/jpeg',
                    data: media.buffer.toString('base64')
                }
            });
        }
    }

    const contents = [{ role: 'user', parts }];
    return await callGemini(contents, systemPrompt, 0.1);
}

/**
 * Interpret user modifications to an existing draft using Gemini
 */
export async function interpretModificationWithGemini(userMessage, currentDraft, webSearchContext = '') {
    const systemPrompt = `
لديك مسودة منتج إلكتروني حالية بالبيانات التالية:
${JSON.stringify(currentDraft, null, 2)}

المستخدم أرسل طلب تعديل بالرسالة التالية:
"${userMessage}"

${webSearchContext ? `معلومات إضافية تم العثور عليها من الإنترنت:\n${webSearchContext}` : ''}

مهمتك استخراج الحقول التي طلب المستخدم تعديلها بدقة وإرجاعها في كائن JSON:
الحقول الممكن تعديلها:
- "name": الاسم الجديد.
- "price_after": السعر الجديد بعد الخصم (رقم صحيح).
- "price_before": السعر قبل الخصم.
- "description": الوصف الجديد (يجب أن يكون مقسماً على أسطر متعددة مرتبة بنقاط).
- "main_category": اسم القسم الرئيسي الجديد (مثال: مستحضرات تجميل).
- "category_name": اسم التصنيف الجديد (مثال: كريمات ترطيب).
- "sizes": مصفوفة المقاسات الجديدة (مثال: ["L", "XL"]).
- "colors": مصفوفة الألوان الجديدة (مثال: ["أسود", "أبيض"]).
- "custom_variants": مصفوفة المتغيرات المخصصة الجديدة (مثال: [{"name": "الحجم", "values": ["50 مل", "100 مل"]}]).
- "price_tiers": مصفوفة الشرائح السعرية الجديدة (مثال: [{"min_qty": 2, "price": 40}, {"min_qty": 3, "price": 50}]).
- "stock": المخزون الجديد (رقم صحيح).

أرجع حصرياً كائن JSON يحتوي فقط على الحقول التي طلب المستخدم تعديلها أو ذكرها صراحة.
`;

    const contents = [{ role: 'user', parts: [{ text: userMessage }] }];
    return await callGemini(contents, systemPrompt, 0.1);
}

/**
 * Format the draft summary message for WhatsApp presentation
 */
function buildDraftSummaryText(draft, storeName) {
    const sizesStr = draft.sizes?.length ? draft.sizes.join(', ') : '';
    const colorsStr = draft.colors?.length ? draft.colors.join(', ') : '';
    const beforeStr = draft.price_before > 0 ? `(قبل الخصم: ${draft.price_before} ج)` : '';

    // Format custom variants string
    let cvStr = '';
    if (draft.custom_variants && Array.isArray(draft.custom_variants)) {
        cvStr = draft.custom_variants
            .filter(cv => cv && cv.name && cv.values?.length)
            .map(cv => `⚖️ *${cv.name}:* ${cv.values.join('، ')}`)
            .join('\n');
    }

    // Format price tiers string
    let tiersStr = '';
    if (draft.price_tiers && Array.isArray(draft.price_tiers)) {
        const tiersList = draft.price_tiers
            .filter(t => t && t.min_qty && t.price)
            .map(t => `${t.min_qty} قطع بسعر ${t.price} ج`)
            .join(' | ');
        if (tiersList) {
            tiersStr = `🎁 *عروض الكميات:* ${tiersList}`;
        }
    }

    let msg = `🤖 *تم تجهيز مسودة المنتج لمتجر: [${storeName}]*\n` +
              `──────────────────\n` +
              `🏷️ *الاسم:* ${draft.name}\n` +
              `💰 *السعر:* ${draft.price_after} ج ${beforeStr}\n`;

    if (tiersStr) msg += `${tiersStr}\n`;
    if (sizesStr) msg += `📏 *المقاسات:* ${sizesStr}\n`;
    if (colorsStr) msg += `🎨 *الألوان:* ${colorsStr}\n`;
    if (cvStr) msg += `${cvStr}\n`;

    msg += `📁 *القسم الرئيسي:* ${draft.main_category || 'عام'}\n` +
           `📂 *التصنيف:* ${draft.category_name || 'عام'}\n` +
           `📦 *المخزون:* ${draft.stock || 100} قطعة\n`;

    if (draft.images_count > 0) {
        msg += `🖼️ *الصور:* ${draft.images_count} صور مرفوعة (الأولى رئيسية)\n`;
    }

    if (draft.description) {
        msg += `──────────────────\n` +
               `📝 *الوصف الترويجي:*\n${draft.description}\n`;
    }

    msg += `──────────────────\n` +
           `🔍 *رابط المعاينة السري (مسودة مخفية عن الزوار):*\n` +
           `${draft.preview_url}\n` +
           `──────────────────\n` +
           `👈 *اكتب ( 1 )* لنشر المنتج فوراً لايف على المتجر.\n` +
           `👈 *أرسل أي تعديل* بالعامية (مثال: "القطعتين بـ 40" أو "غير الحجم" أو "ابحث في النت عن الوصف").\n` +
           `👈 *اكتب ( 3 )* لإلغاء وحذف المسودة نهائياً.`;

    return msg;
}

/**
 * Main Entry Point: Handle incoming WhatsApp message from staff
 * Returns { handled: boolean }
 */
export async function handleStaffMessage({ sock, msg, remoteJid, phoneNumber, text, mediaBuffer, mediaMime, userId, io }) {
    const cleanPhone = normalizePhone(phoneNumber);
    const sessionKey = cleanPhone || remoteJid;

    // Check authorization: Rady (01092308465) or recognized staff
    const auth = await isStaffAuthorized(cleanPhone);

    // If sender is not authorized staff and has no active session, ignore
    if (!auth && !staffSessions.has(sessionKey)) {
        return { handled: false };
    }

    const session = getStaffSession(sessionKey);
    const trimmedText = (text || '').trim();

    // ================================================================
    // Command 1: /store <slug_or_phone> (Open / Switch Store Session)
    // ================================================================
    if (trimmedText.startsWith('/store') || trimmedText.startsWith('/متجر')) {
        const query = trimmedText.replace(/^(\/store|\/متجر)\s*/i, '').trim();

        if (!query) {
            await replyToStaff(sock, remoteJid, '⚠️ يرجى كتابة كود المتجر أو رقم هاتف التاجر بعد الأمر.\nمثال: `/store modastore` أو `/store 01012345678`', userId, io);
            return { handled: true };
        }

        try {
            await replyToStaff(sock, remoteJid, `🔍 جاري البحث عن المتجر [${query}]...`, userId, io);
            const lookup = await callFastOrderApi(`/store-lookup?store=${encodeURIComponent(query)}`);

            if (lookup.success && lookup.data) {
                session.activeStore = lookup.data;
                session.currentDraft = null;
                session.pendingMedia = [];
                session.pendingText = '';

                const categoriesList = lookup.data.categories?.length
                    ? lookup.data.categories.map(c => c.name_ar || c.name).slice(0, 8).join('، ')
                    : 'عام';

                const mainList = lookup.data.main_categories?.length
                    ? lookup.data.main_categories.slice(0, 6).join('، ')
                    : 'عام';

                await replyToStaff(sock, remoteJid, 
                    `🟢 *تم تفعيل متجر:* [${lookup.data.name}] (${lookup.data.slug})\n` +
                    `🌐 الرابط: ${lookup.data.store_url}\n` +
                    `📁 الأقسام الرئيسية: ${mainList}\n` +
                    `📂 التصنيفات المتاحة: ${categoriesList}\n` +
                    `──────────────────\n` +
                    `📸 *جاهز لاستقبال صور وبوست المنتج الأول.*\n` +
                    `ارفع الصور والبوست معاً أو ورا بعض وسأقوم بتجهيز المسودة ورابط المعاينة السري فوراً!\n\n` +
                    `(للإغلاق في أي وقت اكتب */close*)`,
                    userId, io
                );
            }
        } catch (e) {
            await replyToStaff(sock, remoteJid, `❌ تعذر فتح المتجر: ${e.message}\nتأكد من كتابة كود المتجر (Slug) أو رقم هاتف التاجر بشكل صحيح.`, userId, io);
        }
        return { handled: true };
    }

    // ================================================================
    // Command 2: /close (Close Current Store Session)
    // ================================================================
    if (trimmedText === '/close' || trimmedText === '/خروج' || trimmedText === '/قفل') {
        const storeName = session.activeStore?.name || 'الجلسة';
        session.activeStore = null;
        session.currentDraft = null;
        session.pendingMedia = [];
        session.pendingText = '';

        await replyToStaff(sock, remoteJid, `🔴 تم إغلاق جلسة متجر [${storeName}] بنجاح.\nلفتح متجر جديد اكتب: */store كود_المتجر*`, userId, io);
        return { handled: true };
    }

    // ================================================================
    // Command 3: /status (Check Status)
    // ================================================================
    if (trimmedText === '/status' || trimmedText === '/حالة') {
        if (!session.activeStore) {
            await replyToStaff(sock, remoteJid, '⚪ لا توجد جلسة متجر مفعلة حالياً.\nللبدء اكتب: */store كود_المتجر*', userId, io);
        } else {
            let statusMsg = `🟢 المتجر النشط حالياً: *${session.activeStore.name}* (${session.activeStore.slug})\n`;
            if (session.currentDraft) {
                statusMsg += `📝 توجد مسودة معلقة بإنتظار موافقتك:\n` +
                             `🏷️ ${session.currentDraft.name} (${session.currentDraft.price_after} ج)\n` +
                             `🔍 المعاينة: ${session.currentDraft.preview_url}\n` +
                             `👉 اكتب *1* للنشر، أو أرسل تعديلاتك، أو *3* للحذف.`;
            } else {
                statusMsg += `✨ جاهز لاستقبال صور وبوست المنتج القادم...`;
            }
            await replyToStaff(sock, remoteJid, statusMsg, userId, io);
        }
        return { handled: true };
    }

    // If staff has NO active store session and sent something else
    if (!session.activeStore) {
        if (mediaBuffer || (trimmedText && trimmedText.length > 10)) {
            await replyToStaff(sock, remoteJid, '⚠️ يرجى تفعيل متجر التاجر أولاً قبل إرسال المنتجات.\nاكتب: */store كود_المتجر* أو */store رقم_التاجر*', userId, io);
            return { handled: true };
        }
        return { handled: false };
    }

    // ================================================================
    // Action: 1 / موافق / نشر (Publish Draft to Live Store)
    // ================================================================
    if ((trimmedText === '1' || trimmedText === 'نشر' || trimmedText === 'موافق') && session.currentDraft) {
        try {
            await replyToStaff(sock, remoteJid, '🚀 جاري تفعيل ونشر المنتج على المتجر لايف...', userId, io);
            const pub = await callFastOrderApi(`/products/draft/${session.currentDraft.id}/publish`, 'POST');

            if (pub.success) {
                const liveUrl = pub.data?.live_url || `${session.activeStore.store_url}/shop/product.html?id=${session.currentDraft.id}`;
                const publishedName = pub.data?.name || session.currentDraft.name;
                const price = pub.data?.price || session.currentDraft.price_after;

                // Clear current draft
                session.currentDraft = null;
                session.pendingMedia = [];
                session.pendingText = '';

                await replyToStaff(sock, remoteJid, 
                    `✅ *تم نشر المنتج بنجاح لايف على المتجر!* 🚀\n` +
                    `🏷️ *الاسم:* ${publishedName}\n` +
                    `💰 *السعر:* ${price} ج\n` +
                    `🌐 *رابط المنتج المباشر:*\n${liveUrl}\n` +
                    `──────────────────\n` +
                    `✨ *جاهز لاستقبال المنتج التالي لنفس المتجر [${session.activeStore.name}]...*\n` +
                    `أرسل صور ووصف الموديل القادم مباشرة.`,
                    userId, io
                );
            }
        } catch (e) {
            await replyToStaff(sock, remoteJid, `❌ فشل نشر المنتج: ${e.message}`, userId, io);
        }
        return { handled: true };
    }

    // ================================================================
    // Action: 3 / حذف / الغاء (Discard Current Draft)
    // ================================================================
    if ((trimmedText === '3' || trimmedText === 'حذف' || trimmedText === 'الغاء') && session.currentDraft) {
        try {
            await callFastOrderApi(`/products/draft/${session.currentDraft.id}`, 'DELETE');
            session.currentDraft = null;
            session.pendingMedia = [];
            session.pendingText = '';

            await replyToStaff(sock, remoteJid, `🗑️ تم إلغاء وحذف مسودة المنتج بنجاح.\nجاهز لاستقبال منتج آخر لمتجر [${session.activeStore.name}].`, userId, io);
        } catch (e) {
            await replyToStaff(sock, remoteJid, `❌ خطأ أثناء الحذف: ${e.message}`, userId, io);
        }
        return { handled: true };
    }

    // ================================================================
    // Action: Modifications to pending draft
    // If draft exists, no new image, and text is not a command
    // ================================================================
    if (session.currentDraft && !mediaBuffer && trimmedText && !trimmedText.startsWith('/')) {
        try {
            await replyToStaff(sock, remoteJid, '✏️ جاري تعديل بيانات المسودة بالذكاء الاصطناعي...', userId, io);

            // Check if user asked for a web search for description
            let webContext = '';
            const wantsSearch = /ابحث|بحث|جوجل|النت|google/i.test(trimmedText);
            if (wantsSearch) {
                await replyToStaff(sock, remoteJid, '🌐 جاري البحث في الإنترنت لجلب تفاصيل ووصف دقيق للمنتج...', userId, io);
                const query = session.currentDraft.name || trimmedText;
                webContext = await performProductWebSearch(query);
            }

            const updates = await interpretModificationWithGemini(trimmedText, session.currentDraft, webContext);

            if (!updates || Object.keys(updates).length === 0) {
                await replyToStaff(sock, remoteJid, '⚠️ لم أتمكن من استخراج التعديل المطلوب. يرجى توضيح التعديل بشكل أوضح (مثال: "السعر 400" أو "القطعتين بـ 50" أو "الحجم 50 مل").', userId, io);
                return { handled: true };
            }

            const patchRes = await callFastOrderApi(`/products/draft/${session.currentDraft.id}`, 'PATCH', updates);

            if (patchRes.success && patchRes.data) {
                session.currentDraft = patchRes.data;
                const summary = buildDraftSummaryText(patchRes.data, session.activeStore.name);
                await replyToStaff(sock, remoteJid, summary, userId, io);
            }
        } catch (e) {
            await replyToStaff(sock, remoteJid, `❌ خطأ أثناء تطبيق التعديل: ${e.message}`, userId, io);
        }
        return { handled: true };
    }

    // ================================================================
    // Ingestion Flow: Receive Photos and Text for a New Product
    // Debounces incoming messages (3.5s) to collect all images & parts
    // ================================================================
    if (mediaBuffer) {
        session.pendingMedia.push({
            buffer: mediaBuffer,
            mimetype: mediaMime || 'image/jpeg',
            filename: `img_${Date.now()}_${session.pendingMedia.length}.jpg`
        });
    }

    if (trimmedText && !trimmedText.startsWith('📷')) {
        session.pendingText += (session.pendingText ? '\n' : '') + trimmedText;
    }

    // Clear previous debounce timer if exists
    if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
    }

    // Set debounce timer (3.5 seconds) to allow multi-image / multi-text to arrive
    session.debounceTimer = setTimeout(async () => {
        try {
            await processCollectedProduct(sock, remoteJid, session, userId, io);
        } catch (err) {
            console.error('Error in processCollectedProduct:', err);
            await replyToStaff(sock, remoteJid, `❌ حدث خطأ أثناء معالجة المنتج: ${err.message}\nيرجى المحاولة مرة أخرى.`, userId, io);
        }
    }, 3500);

    return { handled: true };
}

/**
 * Process collected media and text after debounce timer fires
 */
async function processCollectedProduct(sock, remoteJid, session, userId, io) {
    const images = session.pendingMedia.slice();
    const postText = session.pendingText.trim();

    // If no text was provided yet, wait for text
    if (!postText && images.length > 0) {
        await replyToStaff(sock, remoteJid, 
            `📷 استلمت (${images.length}) صور لمنتج جديد في متجر [${session.activeStore.name}].\n` +
            `يرجى إرسال بوست الوصف والأسعار للبدء في تحليل وتجهيز المسودة.`,
            userId, io
        );
        return;
    }

    await replyToStaff(sock, remoteJid, `⏳ جاري تحليل بيانات المنتج بالذكاء الاصطناعي وتجهيز المسودة لمتجر [${session.activeStore.name}]...`, userId, io);

    // Check if user requested web search
    let webContext = '';
    if (/ابحث|بحث|جوجل|النت|google/i.test(postText)) {
        await replyToStaff(sock, remoteJid, '🌐 جاري البحث في الإنترنت عن مواصفات المنتج لدعم الوصف...', userId, io);
        webContext = await performProductWebSearch(postText.substring(0, 100));
    }

    // 1. Call Gemini 2.5 Flash
    const extracted = await extractProductWithGemini(postText, images, webContext);

    if (!extracted) {
        await replyToStaff(sock, remoteJid, '❌ تعذر استخراج تفاصيل المنتج من الصور والبوست. يرجى التأكد من وضوح البيانات والمحاولة مرة أخرى.', userId, io);
        return;
    }

    // 2. Check for missing essential fields
    if (extracted.missing_fields && extracted.missing_fields.includes('price')) {
        await replyToStaff(sock, remoteJid, 
            `⚠️ تم استخراج تفاصيل المنتج [${extracted.name}] بنجاح ولكن *السعر غير محدد* في البوست!\n` +
            `يرجى إرسال سعر البيع (وقبل الخصم إن وجد) لنتمكن من حفظ المسودة.\nمثال: "السعر 350 وقبل الخصم 450"`,
            userId, io
        );
        return;
    }

    // 3. Prepare payload for Fast Order Internal API
    const base64Images = images.map(img => img.buffer.toString('base64'));

    const draftPayload = {
        store_slug: session.activeStore.slug,
        name: extracted.name || 'منتج جديد',
        description: extracted.description || '',
        price_after: Number(extracted.price_after) || 0,
        price_before: Number(extracted.price_before) || 0,
        sizes: extracted.sizes || [],
        colors: extracted.colors || [],
        custom_variants: extracted.custom_variants || [],
        price_tiers: extracted.price_tiers || [],
        stock: Number(extracted.stock) || 100,
        main_category: extracted.main_category || null,
        category_name: extracted.category_name || null,
        images_base64: base64Images
    };

    // 4. Create Draft in Fast Order
    const createRes = await callFastOrderApi('/products/draft', 'POST', draftPayload);

    if (createRes.success && createRes.data) {
        session.currentDraft = createRes.data;
        session.pendingMedia = [];
        session.pendingText = '';

        const summary = buildDraftSummaryText(createRes.data, session.activeStore.name);
        await replyToStaff(sock, remoteJid, summary, userId, io);
    } else {
        await replyToStaff(sock, remoteJid, `❌ فشل حفظ المسودة: ${createRes.message || 'خطأ غير معروف'}`, userId, io);
    }
}
