import fetch from 'node-fetch';
import { CONFIG } from '../config.js';
import User from '../models/User.js';
import Instruction from '../models/Instruction.js';
import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import Message from '../models/Message.js';
import { GoogleAuth } from 'google-auth-library';
import { notifyControlGroup } from './botController.js';
import { vertexQueue } from '../services/queueService.js';
import InteractiveMenu from '../models/InteractiveMenu.js';
import InteractiveButton from '../models/InteractiveButton.js';
import Product from '../models/Product.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';

// الـ Verify Token اللي بنستخدمه مع ميتا
const VERIFY_TOKEN = 'lina_messenger_verify_2024';

// ======================================================
// دالة للتحقق من الـ Webhook اللي بتطلبها ميتا (GET)
// ======================================================
export function verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ [Messenger] Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ [Messenger] Webhook verification failed!');
        res.sendStatus(403);
    }
}

// ======================================================
// دالة لاستقبال الرسائل القادمة من ميتا (POST)
// ======================================================
export async function handleWebhook(req, res) {
    // دايماً نبعت 200 فوراً عشان ميتا ما تعيد المحاولة
    res.sendStatus(200);

    const body = req.body;
    console.log('📨 [Messenger Webhook] Received event:', JSON.stringify(body).substring(0, 300));

    if (body.object !== 'page') {
        console.log('⚠️ [Messenger Webhook] Not a page event, ignoring.');
        return;
    }

    for (const entry of body.entry) {
        const pageId = entry.id;
        console.log(`📌 [Messenger] Entry from page: ${pageId}`);

        // ======================================================
        // معالجة أحداث الكومنتات (feed changes)
        // ======================================================
        if (entry.changes && entry.changes.length > 0) {
            for (const change of entry.changes) {
                if (change.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
                    const commentData = change.value;
                    console.log(`💬 [Messenger] New comment on page ${pageId}:`, JSON.stringify(commentData).substring(0, 200));
                    try {
                        await handleCommentEvent(pageId, commentData);
                    } catch (err) {
                        console.error(`[Messenger] Error handling comment:`, err);
                    }
                }
            }
        }

        // ======================================================
        // معالجة رسائل الماسنجر (messaging events)
        // ======================================================
        if (entry.messaging && entry.messaging.length > 0) {
            for (const event of entry.messaging) {
                // 1. معالجة أحداث التوصيل (Delivery)
                if (event.delivery) {
                    const mids = event.delivery.mids;
                    if (mids && mids.length > 0) {
                        try {
                            const CampaignModule = await import('../models/Campaign.js');
                            const Campaign = CampaignModule.default;
                            for (const mid of mids) {
                                const msg = await Message.findOne({ where: { messageId: mid } });
                                if (msg && msg.CampaignId && msg.status === 'sent') {
                                    msg.status = 'delivered';
                                    await msg.save();
                                    const campaign = await Campaign.findByPk(msg.CampaignId);
                                    if (campaign) {
                                        await campaign.increment('deliveredCount');
                                    }
                                }
                            }
                        } catch (err) {
                            console.error('[Messenger Delivery Event Error]:', err);
                        }
                    }
                    continue;
                }

                // 2. معالجة أحداث القراءة (Read / Watermark)
                if (event.read) {
                    const watermark = event.read.watermark;
                    const senderId = event.sender.id;
                    const conversationId = `msng_${pageId}_${senderId}`;
                    try {
                        const CampaignModule = await import('../models/Campaign.js');
                        const Campaign = CampaignModule.default;
                        const unreadMsgs = await Message.findAll({
                            where: {
                                remoteJid: conversationId,
                                role: 'model',
                                CampaignId: { [Op.ne]: null },
                                status: { [Op.in]: ['sent', 'delivered'] },
                                createdAt: { [Op.lte]: new Date(watermark) }
                            }
                        });
                        for (const msg of unreadMsgs) {
                            const oldStatus = msg.status;
                            msg.status = 'read';
                            await msg.save();
                            
                            const campaign = await Campaign.findByPk(msg.CampaignId);
                            if (campaign) {
                                if (oldStatus === 'sent') {
                                    await campaign.increment('deliveredCount');
                                }
                                await campaign.increment('readCount');
                            }
                        }
                    } catch (err) {
                        console.error('[Messenger Read Event Error]:', err);
                    }
                    continue;
                }

                // معالجة الـ echo (الرسائل المرسلة من الصفحة)
                if (event.message?.is_echo) {
                    const customerId = event.recipient?.id;
                    const appId = event.message.app_id;
                    const myAppId = process.env.FB_APP_ID;
                    
                    // لو مافيش app_id أو الـ app_id مش بتاعنا، معناه إن موظف رد من الـ Inbox
                    if (!appId || (myAppId && String(appId) !== String(myAppId))) {
                        if (customerId) {
                            console.log(`👤 [Takeover] Human manually replied to ${customerId} on page ${pageId}. Disabling AI.`);
                            try {
                                await MessengerConversation.update(
                                    { is_handoff: true },
                                    { where: { pageId: pageId, senderId: customerId } }
                                );
                            } catch (err) {
                                console.error('[Takeover] Error updating is_handoff:', err);
                            }
                        }
                    }
                    continue;
                }
                
                // تجاهل الـ read و delivery events
                if (!event.message?.text) continue;

                const senderId = event.sender.id;
                const messageText = event.message.text;
                const buttonPayload = event.message.quick_reply?.payload || null;
                console.log(`💬 [Messenger] Message from ${senderId}: "${messageText}"${buttonPayload ? ` (Payload: ${buttonPayload})` : ''}`);

                // 3. تتبع الردود على حملات ماسنجر (repliedCount)
                try {
                    const CampaignModule = await import('../models/Campaign.js');
                    const Campaign = CampaignModule.default;
                    const lastCampaignMsg = await Message.findOne({
                        where: {
                            remoteJid: `msng_${pageId}_${senderId}`,
                            role: 'model',
                            CampaignId: { [Op.ne]: null },
                            replied: false
                        },
                        order: [['createdAt', 'DESC']]
                    });
                    if (lastCampaignMsg) {
                        lastCampaignMsg.replied = true;
                        await lastCampaignMsg.save();
                        const campaign = await Campaign.findByPk(lastCampaignMsg.CampaignId);
                        if (campaign) {
                            await campaign.increment('repliedCount');
                        }
                    }
                } catch (err) {
                    console.error('[Messenger Broadcast Reply Tracking Error]:', err);
                }

                try {
                    await processMessengerMessage(pageId, senderId, messageText, null, buttonPayload);
                } catch (err) {
                    console.error(`[Messenger] Error processing message from ${senderId}:`, err);
                }
            }
        }
    }
}

// ======================================================
// معالجة حدث الكومنت: لايك + رد ترحيبي + فتح ماسنجر بالـ AI
// ======================================================
async function handleCommentEvent(pageId, commentData) {
    // جيب بيانات الصفحة من قاعدة البيانات
    const page = await MessengerPage.findOne({ where: { pageId, isActive: true } });
    if (!page) {
        console.warn(`[Messenger Comment] No active page found for pageId: ${pageId}`);
        return;
    }

    const accessToken = page.accessToken;
    const commentId = commentData.comment_id;
    const commenterId = commentData.from?.id;
    const commenterName = commentData.from?.name || 'العميل';
    const commentText = commentData.message || '';

    if (!commentId || !commenterId) {
        console.warn('[Messenger Comment] Missing commentId or commenterId, skipping.');
        return;
    }

    // تجاهل لو الكومنت من الصفحة نفسها (Bot echo)
    if (commenterId === pageId) {
        console.log('[Messenger Comment] Comment from page itself, ignoring.');
        return;
    }

    console.log(`💬 [Comment] From: ${commenterName} (${commenterId}) | Text: "${commentText}"`);

    // 1. عمل لايك على الكومنت
    await likeComment(commentId, accessToken);

    // 2. الرد على الكومنت بالرسالة الترحيبية
    const firstName = commenterName.split(' ')[0];
    let publicReply = page.defaultComment || 'أهلاً وسهلاً بحضرتك 😊\nتم إرسال التفاصيل لك في الرسائل الخاصة ✅';
    publicReply = publicReply.replace('{name}', firstName);
    await replyToComment(commentId, publicReply, accessToken);

    // 3. فتح محادثة ماسنجر مع العميل
    // لو النظام = fixed reply: ابعت الرد الثابت مرة واحدة بس
    if (page.replyMode === 'fixed') {
        if (page.fixedReply && commenterId) {
            const fixedMsg = page.fixedReply.replace('{name}', firstName);
            try {
                // تحديث أو إنشاء المحادثة
                const [conv, wasCreated] = await (await import('../models/MessengerConversation.js')).default.findOrCreate({
                    where: { pageId, senderId: commenterId },
                    defaults: { UserId: page.UserId, pageId, senderId: commenterId, messageCount: 1, is_handoff: false }
                });
                
                // لو كانت المحادثة موجودة مسبقاً، زود الـ count عشان ما يردش تاني في الشات
                if (!wasCreated) {
                    await conv.increment('messageCount');
                }

                let quickReplies = null;
                if (page.useButtonsWithFixedReply) {
                    quickReplies = await getInteractiveMenuQuickReplies(page.UserId);
                }
                
                // إرسال الرد الثابت دائماً مع أي كومنت جديد
                await sendPrivateReplyToComment(commentId, fixedMsg, accessToken, quickReplies);
                console.log(`✅ [Fixed Reply] Sent fixed reply to ${commenterId} (via comment)`);
            } catch (err) {
                console.error('[Fixed Reply Comment] Error:', err);
            }
        }
        return;
    }

    // وضع AI: ابعت الرد بالذكاء الاصطناعي
    if (commentText.trim().length > 0) {
        try {
            await processMessengerMessage(pageId, commenterId, commentText, commentId);
        } catch (err) {
            console.error('[Messenger Comment] Error processing AI reply:', err);
        }
    }
}

// ======================================================
// عمل لايك على كومنت
// ======================================================
async function likeComment(commentId, accessToken) {
    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/${commentId}/likes?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (data.success || data === true) {
            console.log(`✅ [Comment] Liked comment: ${commentId}`);
        } else {
            console.warn(`⚠️ [Comment] Failed to like comment ${commentId}:`, data);
        }
    } catch (err) {
        console.error(`[Comment] Error liking comment ${commentId}:`, err);
    }
}

// ======================================================
// الرد على كومنت عام
// ======================================================
async function replyToComment(commentId, message, accessToken) {
    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/${commentId}/comments?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message.substring(0, 2000) })
        });
        const data = await response.json();
        if (data.id) {
            console.log(`✅ [Comment] Replied to comment: ${commentId}`);
        } else {
            console.warn(`⚠️ [Comment] Failed to reply to comment ${commentId}:`, data);
        }
    } catch (err) {
        console.error(`[Comment] Error replying to comment ${commentId}:`, err);
    }
}

// ======================================================
// الدالة الرئيسية لمعالجة الرسائل والرد عليها بالـ AI
// ======================================================
async function processMessengerMessage(pageId, senderId, messageText, commentId = null, buttonPayload = null) {
    // 1. جيب بيانات الصفحة من قاعدة البيانات
    const page = await MessengerPage.findOne({ where: { pageId, isActive: true } });
    if (!page) {
        console.warn(`[Messenger] No active page found for pageId: ${pageId}`);
        return;
    }

    const userId = page.UserId;
    const accessToken = page.accessToken;

    let typingInterval = null;
    if (page.replyMode === 'ai') {
        // إرسال علامة "يكتب الآن..." فوراً في وضع الذكاء الاصطناعي فقط
        sendMessengerAction(senderId, 'typing_on', accessToken);
        // تكرار إرسال العلامة كل 8 ثواني عشان ماتختفيش لو الرد اتأخر
        typingInterval = setInterval(() => {
            sendMessengerAction(senderId, 'typing_on', accessToken);
        }, 8000);
    }

    try {
        // === Interactive Button Payload & Trigger Interception ===
        let matchedButtonId = null;
        if (buttonPayload && buttonPayload.startsWith('BTN_')) {
            matchedButtonId = parseInt(buttonPayload.replace('BTN_', ''), 10);
        } else if (messageText && messageText.trim() !== '') {
            // Check trigger words
            const menus = await InteractiveMenu.findAll({ where: { UserId: userId, isActive: true } });
            const normalizedText = messageText.trim().toLowerCase();
            for (const menu of menus) {
                if (menu.triggerWords) {
                    const triggers = menu.triggerWords.split(',').map(w => w.trim().toLowerCase());
                    if (triggers.includes(normalizedText)) {
                        if (commentId) {
                            const quickReplies = await getInteractiveMenuQuickReplies(userId);
                            await sendPrivateReplyToComment(commentId, menu.welcomeMessage || 'أهلاً بيك! اختار من القائمة:', accessToken, quickReplies);
                        } else {
                            await sendMessengerInteractiveMenu(userId, senderId, accessToken, menu.id);
                        }
                        clearInterval(typingInterval);
                        return; // Stop processing
                    }
                }
            }
        }

        if (matchedButtonId) {
            const button = await InteractiveButton.findOne({
                where: { id: matchedButtonId, isActive: true }
            });

            if (button) {
                // 1. Send Product if attached
                if (button.ProductId) {
                    const product = await Product.findOne({ where: { id: button.ProductId, UserId: userId, isActive: true } });
                    if (product) {
                        const productCaption = `📦 *${product.name}*\n\n${product.description || ''}\n\nالسعر: ${product.price ? product.price + ' ' + product.currency : 'تواصل معنا لمعرفة السعر'}`;
                        
                        if (product.images && product.images.length > 0) {
                            for (let i = 0; i < product.images.length; i++) {
                                const imgUrl = product.images[i].url;
                                if (!imgUrl) continue;
                                const imagePath = path.join(process.cwd(), 'public', imgUrl);
                                if (!fs.existsSync(imagePath)) continue;
                                
                                try {
                                    const form = new FormData();
                                    form.append('recipient', JSON.stringify({ id: senderId }));
                                    form.append('message', JSON.stringify({ attachment: { type: "image", payload: { is_reusable: true } } }));
                                    form.append('filedata', fs.createReadStream(imagePath));
                                    
                                    const imgResponse = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
                                        method: 'POST',
                                        body: form
                                    });
                                    const imgData = await imgResponse.json();
                                    if (imgData.error) {
                                        console.error('[Messenger] Failed to send product image:', imgData.error);
                                    } else {
                                        console.log(`✅ [Messenger] Product image sent successfully: ${imgUrl}`);
                                    }
                                } catch (e) { console.error('[Messenger] Failed to send product image exception:', e); }
                            }
                        }
                        await sendMessengerReply(senderId, productCaption, accessToken);
                        await Message.create({ UserId: userId, remoteJid: `msng_${pageId}_${senderId}`, role: 'model', content: productCaption });
                    }
                }
                
                // 2. Send the response text/image
                if (button.responseText && button.responseText.trim() !== '') {
                    if (button.responseImage) {
                        const images = button.responseImage.split(',').filter(i => i.trim() !== '');
                        for (const imgUrl of images) {
                            const imagePath = path.join(process.cwd(), 'public', imgUrl);
                            if (fs.existsSync(imagePath)) {
                                try {
                                    const form = new FormData();
                                    form.append('recipient', JSON.stringify({ id: senderId }));
                                    form.append('message', JSON.stringify({ attachment: { type: "image", payload: { is_reusable: true } } }));
                                    form.append('filedata', fs.createReadStream(imagePath));
                                    
                                    const respImageRes = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
                                        method: 'POST',
                                        body: form
                                    });
                                    const respImageData = await respImageRes.json();
                                    if (respImageData.error) {
                                        console.error('[Messenger] Failed to send response image:', respImageData.error);
                                    } else {
                                        console.log(`✅ [Messenger] Response image sent successfully: ${imgUrl}`);
                                    }
                                } catch (e) { console.error('[Messenger] Failed to send response image exception:', e); }
                            }
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    await sendMessengerReply(senderId, button.responseText, accessToken);
                    await Message.create({ UserId: userId, remoteJid: `msng_${pageId}_${senderId}`, role: 'model', content: button.responseText });
                }

                // 3. Send Next Menu or Resend Current Menu
                if (button.NextMenuId) {
                    await sendMessengerInteractiveMenu(userId, senderId, accessToken, button.NextMenuId);
                } else if (!button.continueToAI) {
                    await sendMessengerInteractiveMenu(userId, senderId, accessToken, button.MenuId);
                }

                clearInterval(typingInterval);
                return; 
            }
        }
        // === End Interception ===
        // 2. اعمل أو حدّث بيانات الـ conversation
        let [conversation, created] = await MessengerConversation.findOrCreate({
            where: { pageId, senderId },
            defaults: { UserId: userId, pageId, senderId, messageCount: 0, is_handoff: false }
        });

        // 3. جيب اسم المرسل من ميتا (لو مجبناهوش قبل كده)
        if (created || conversation.senderName === 'عميل') {
            try {
                const profileRes = await fetch(`https://graph.facebook.com/v18.0/${senderId}?fields=name&access_token=${accessToken}`);
                const profileData = await profileRes.json();
                if (profileData.name) {
                    await conversation.update({ senderName: profileData.name });
                }
            } catch (e) {
                // لو مش قادر يجيب الاسم، مش مشكلة
            }
        }

        // 4. احفظ الرسالة في جدول الرسائل
        const conversationId = `msng_${pageId}_${senderId}`;
        await Message.create({
            UserId: userId,
            remoteJid: conversationId,
            role: 'user',
            content: messageText
        });

        // 5. حدّث عدد الرسائل وتاريخ آخر رسالة
        // نحتفظ بـ messageCount القديم قبل التحديث للتحقق منه في الرد الثابت
        const previousMessageCount = conversation.messageCount;
        await conversation.update({
            messageCount: conversation.messageCount + 1,
            lastMessageAt: new Date()
        });

        // إذا كان الموظف قد تدخل، نوقف الرد
        if (conversation.is_handoff) {
            console.log(`⏸️ [Takeover] AI is paused for ${senderId}. Skipping reply.`);
            clearInterval(typingInterval);
            return;
        }

        // ====== وضع الرد الثابت ======
        if (page.replyMode === 'fixed') {
            if (page.fixedReply) {
                // إرسال الرد الثابت مرة واحدة فقط للمستخدم الجديد (أو المحادثة الفارغة)
                if (created || previousMessageCount === 0) {
                    const fixedMsg = page.fixedReply;
                    await Message.create({ UserId: userId, remoteJid: conversationId, role: 'model', content: fixedMsg });
                    
                    if (commentId) {
                        let quickReplies = null;
                        if (page.useButtonsWithFixedReply) {
                            quickReplies = await getInteractiveMenuQuickReplies(userId);
                        }
                        await sendPrivateReplyToComment(commentId, fixedMsg, accessToken, quickReplies);
                        console.log(`✅ [Fixed Reply] Sent to ${senderId} (via comment)`);
                    } else {
                        // التحقق من تفعيل الرد على الرسائل بالرد الثابت
                        if (page.replyToMessagesWithFixed) {
                            await sendMessengerReply(senderId, fixedMsg, accessToken);
                            console.log(`✅ [Fixed Reply] Sent to ${senderId}`);
                            
                            // إرسال الأزرار التفاعلية إذا كانت مفعلة وتم إرسال الرد الثابت
                            if (page.useButtonsWithFixedReply) {
                                await sendMessengerInteractiveMenu(userId, senderId, accessToken);
                            }
                        } else {
                            console.log(`⏸️ [Fixed Reply] Skipped sending to ${senderId} (replyToMessagesWithFixed is OFF)`);
                        }
                    }
                }
            }
            clearInterval(typingInterval);
            return;
        }

        // 6. استدعي الـ AI للرد
        let aiReply = await callVertexAIForMessenger(userId, senderId, messageText, conversationId);

        if (aiReply) {
            // Check for AI Handoff trigger
            if (aiReply.includes('[HANDOFF]')) {
                console.log(`🤖 [AI Handoff] AI decided to transfer conversation ${senderId} to human.`);
                await conversation.update({ is_handoff: true });
                
                const handoffMessage = "عفواً، سأقوم بتحويلك الآن لأحد ممثلي خدمة العملاء للرد على استفسارك بدقة. يرجى الانتظار لحين الرد عليك.";
                await Message.create({ UserId: userId, remoteJid: conversationId, role: 'model', content: handoffMessage });
                await sendMessengerReply(senderId, handoffMessage, accessToken);
                
                // Notify WhatsApp Control Group
                try {
                    const notifyMsg = `🚨 *طلب تدخل بشري (تحويل تلقائي)*\n\n👤 العميل: ${conversation.senderName || senderId}\n📱 المنصة: ماسنجر\n\nيرجى التوجه للوحة التحكم للرد على العميل.`;
                    await notifyControlGroup(userId, notifyMsg);
                } catch (e) {
                    console.error("Failed to notify control group for messenger handoff", e);
                }
                
                return;
            }

            // FIX: Clean up Markdown links [text](url) -> url (if text is similar) to prevent duplication in Messenger
            aiReply = aiReply.replace(/\[([^\]]*?)\]\(([^)]+?)\)/g, (match, text, url) => {
                const cleanText = text.trim();
                const cleanUrl = url.trim();
                if (cleanText === cleanUrl || cleanUrl.includes(cleanText)) {
                    return cleanUrl;
                }
                return `${cleanText}: ${cleanUrl}`;
            });

            // 7. احفظ رد الـ AI
            await Message.create({
                UserId: userId,
                remoteJid: conversationId,
                role: 'model',
                content: aiReply
            });

            // 8. ابعت الرد للعميل على الماسنجر
            if (commentId) {
                // دايماً استخدم ميزة Private Reply المخصصة للكومنتات لأي كومنت
                await sendPrivateReplyToComment(commentId, aiReply, accessToken);
            } else {
                await sendMessengerReply(senderId, aiReply, accessToken);
            }
        }
    } finally {
        clearInterval(typingInterval);
    }
}

// ======================================================
// استدعاء Vertex AI خصيصاً للماسنجر
// ======================================================
async function callVertexAIForMessenger(userId, senderId, userText, conversationId) {
    try {
        // جيب التعليمات المفعّلة لهذا المستخدم
        const allInstructions = await Instruction.findAll({
            where: { UserId: userId, isActive: true },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });

        const normalizeText = (text) => text ? text.toLowerCase().trim() : "";
        const userQuery = normalizeText(userText);

        // فلتر التعليمات بنفس منطق الواتساب
        let filteredInstructions = allInstructions.filter(inst => {
            if (inst.type === 'global') return true;
            if (inst.keywords) {
                const keywords = inst.keywords.split(',').map(k => normalizeText(k));
                return keywords.some(k => k.length > 2 && userQuery.includes(k));
            }
            return false;
        });

        // لو مافيش تعليمات مفلترة، خذ global فقط
        if (filteredInstructions.length === 0) {
            filteredInstructions = allInstructions.filter(inst => inst.type === 'global');
        }

        // ابني الـ system prompt
        let systemInstructions = filteredInstructions.map(inst => inst.content).join('\n\n---\n\n');
        
        // Strict anti-hallucination and handoff instruction
        systemInstructions += '\n\n💡 **تعليمات صارمة جداً (يمنع مخالفتها):**\n';
        systemInstructions += '1. أنت مساعد ذكي وملتزم جداً بالتعليمات والبيانات المتوفرة لك فقط.\n';
        systemInstructions += '2. إذا سألك العميل عن أي سؤال أو "سعر" لا يوجد إجابته في السياق الحالي، يمنع منعاً باتاً تأليف أي إجابة من خيالك.\n';
        systemInstructions += '3. إذا شعرت بالارتباك أو طلب العميل التحدث لموظف بشري، يجب عليك الرد بكلمة واحدة فقط وهي بالضبط: [HANDOFF]\n';
        systemInstructions += '4. لا تكتب أي كلام آخر مع كلمة [HANDOFF].\n';

        // جيب آخر 10 رسائل كـ context
        const historySaved = await Message.findAll({
            where: { UserId: userId, remoteJid: conversationId },
            order: [['createdAt', 'DESC']],
            limit: 10
        });
        const history = historySaved.reverse();

        const historyText = history.map(msg =>
            `${msg.role === 'user' ? 'العميل' : 'المساعد'}: ${msg.content}`
        ).join('\n');

        const prompt = `${systemInstructions}\n\nسياق المحادثة السابقة:\n${historyText}\n\nالعميل: ${userText}\nالمساعد:`;

        // Vertex AI URL (uses Service Account authentication)
        const location = 'us-central1';
        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent`;

        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1, // Very low temperature to prevent hallucination
                topK: 20,
                topP: 0.8,
                maxOutputTokens: 1024,
            }
        };

        // Initialize auth with Service Account credentials
        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await vertexQueue.add(async () => {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken.token}`
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Vertex API Error: ${res.status} ${errText}`);
            }
            return res;
        });

        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    } catch (err) {
        console.error('[Messenger] Vertex AI Error:', err);
        return 'عذراً، حدث خطأ مؤقت. يرجى المحاولة مرة أخرى.';
    }
}

// ======================================================
// إرسال رد للماسنجر عبر Graph API
// ======================================================
export async function sendMessengerReply(recipientId, text, accessToken) {
    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { text: text.substring(0, 2000) } // ميتا بتحد الرسالة بـ 2000 حرف
            })
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Messenger] Send Error:', data.error);
            return data;
        } else {
            console.log(`✅ [Messenger] Reply sent to ${recipientId}`);
            return data;
        }
    } catch (err) {
        console.error('[Messenger] Failed to send reply:', err);
        throw err;
    }
}

// ======================================================
// إرسال وسائط (صورة/فيديو) للماسنجر عبر Graph API
// ======================================================
export async function sendMessengerMedia(recipientId, contentType, mediaUrl, accessToken) {
    try {
        const isLocal = !mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://');

        if (isLocal) {
            // Resolve absolute local path
            let localPath = mediaUrl;
            if (mediaUrl.startsWith('/')) {
                localPath = path.join(process.cwd(), 'public', mediaUrl);
            }

            if (fs.existsSync(localPath)) {
                const form = new FormData();
                form.append('recipient', JSON.stringify({ id: recipientId }));
                form.append('message', JSON.stringify({ attachment: { type: contentType, payload: { is_reusable: true } } }));
                form.append('filedata', fs.createReadStream(localPath));

                const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
                    method: 'POST',
                    body: form
                });
                const data = await response.json();
                if (data.error) {
                    console.error(`[Messenger] Failed to send local ${contentType}:`, data.error);
                } else {
                    console.log(`✅ [Messenger] Local ${contentType} sent to ${recipientId}`);
                }
                return data;
            } else {
                throw new Error(`Local file not found: ${localPath}`);
            }
        } else {
            // External URL
            const payload = {
                recipient: { id: recipientId },
                message: {
                    attachment: {
                        type: contentType,
                        payload: {
                            url: mediaUrl,
                            is_reusable: true
                        }
                    }
                }
            };
            const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (data.error) {
                console.error(`[Messenger] Failed to send remote ${contentType}:`, data.error);
            } else {
                console.log(`✅ [Messenger] Remote ${contentType} sent to ${recipientId}`);
            }
            return data;
        }
    } catch (err) {
        console.error(`[Messenger] Failed to send ${contentType}:`, err);
        throw err;
    }
}

// ======================================================
// إرسال رسالة خاصة رداً على كومنت
// ======================================================
async function sendPrivateReplyToComment(commentId, text, accessToken, quickReplies = null) {
    try {
        const payload = {
            recipient: { comment_id: commentId },
            message: { text: text.substring(0, 2000) }
        };
        
        if (quickReplies && quickReplies.length > 0) {
            payload.message.quick_replies = quickReplies;
        }

        const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Messenger] Private Reply Error:', data.error);
        } else {
            console.log(`✅ [Messenger] Private reply sent for comment ${commentId}`);
        }
    } catch (err) {
        console.error('[Messenger] Failed to send private reply:', err);
    }
}

// ======================================================
// إرسال حالة أكشن للماسنجر (مثل typing_on)
// ======================================================
async function sendMessengerAction(recipientId, action, accessToken) {
    try {
        await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                sender_action: action
            })
        });
    } catch (err) {
        console.error(`[Messenger] Failed to send action ${action}:`, err);
    }
}

// ======================================================
// عمل ملخص للمحادثة بالـ AI
// ======================================================
export async function generateConversationSummary(userId, conversationId) {
    try {
        const messages = await Message.findAll({
            where: { UserId: userId, remoteJid: conversationId },
            order: [['createdAt', 'ASC']]
        });

        if (messages.length === 0) return null;

        const conversationText = messages.map(msg =>
            `${msg.role === 'user' ? 'العميل' : 'البوت'}: ${msg.content}`
        ).join('\n');

        const location = 'us-central1';
        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent`;

        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await vertexQueue.add(async () => {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken.token}`
                },
                body: JSON.stringify({
                    contents: [{
                        role: "user",
                        parts: [{
                            text: `اعمل ملخص قصير (3-5 أسطر) لهذه المحادثة مع العميل، اذكر ما طلبه العميل وكيف تم الرد:
${conversationText}`
                        }]
                    }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
                })
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Vertex API Error: ${res.status} ${errText}`);
            }
            return res;
        });

        const data = await response.json();
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || null;

        // احفظ الملخص في قاعدة البيانات
        if (summary) {
            const convId = conversationId.split('_').slice(2).join('_'); // senderId
            await MessengerConversation.update(
                { summary },
                { where: { senderId: convId } }
            );
        }

        return summary;
    } catch (err) {
        console.error('[Messenger] Summary Error:', err);
        return null;
    }
}

// ======================================================
// API Routes للداشبورد
// ======================================================

// جلب كل الصفحات المربوطة للمستخدم
export async function getPages(req, res) {
    try {
        const pages = await MessengerPage.findAll({ where: { UserId: req.user.id } });
        res.json({ success: true, pages });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// ربط صفحة جديدة
export async function connectPage(req, res) {
    try {
        const { pageId, pageName, accessToken } = req.body;
        if (!pageId || !pageName || !accessToken) {
            return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
        }

        const [page, created] = await MessengerPage.findOrCreate({
            where: { pageId },
            defaults: { UserId: req.user.id, pageName, pageId, accessToken, isActive: true }
        });

        if (!created) {
            // لو موجودة قبل كده، حدّثها
            await page.update({ pageName, accessToken, isActive: true });
        }

        // 👉 تفعيل الـ Webhook للصفحة عشان يتبعت لنا الرسائل والكومنتات
        try {
            const subscribeRes = await fetch(
                `https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        subscribed_fields: ['messages', 'messaging_postbacks', 'feed'],
                        access_token: accessToken
                    })
                }
            );
            const subscribeData = await subscribeRes.json();
            if (subscribeData.success) {
                console.log(`[Messenger] ✅ Subscribed to webhooks (messages + feed) for page: ${pageName}`);
            } else {
                console.error(`[Messenger] ⚠️ Failed to subscribe webhook for page ${pageId}:`, subscribeData.error);
            }
        } catch (subErr) {
            console.error(`[Messenger] ⚠️ Error subscribing webhook for page ${pageId}:`, subErr);
        }

        res.json({ success: true, message: `تم ربط صفحة "${pageName}" بنجاح!`, page });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// حذف ربط صفحة
export async function disconnectPage(req, res) {
    try {
        const { pageId } = req.params;
        await MessengerPage.destroy({ where: { pageId, UserId: req.user.id } });
        res.json({ success: true, message: 'تم إلغاء ربط الصفحة' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// تحديث الرد التلقائي لصفحة
export async function updatePageComment(req, res) {
    try {
        const { pageId } = req.params;
        const { defaultComment } = req.body;
        await MessengerPage.update(
            { defaultComment },
            { where: { pageId, UserId: req.user.id } }
        );
        res.json({ success: true, message: 'تم تحديث الرد التلقائي بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// تحديث إعدادات نظام الرد (replyMode + fixedReply)
export async function updatePageSettings(req, res) {
    try {
        const { pageId } = req.params;
        const { replyMode, fixedReply, useButtonsWithFixedReply, replyToMessagesWithFixed, replyToIgMessagesWithFixed } = req.body;

        if (!['ai', 'fixed'].includes(replyMode)) {
            return res.status(400).json({ success: false, message: 'نظام الرد غير صحيح' });
        }

        if (replyMode === 'fixed' && !fixedReply?.trim()) {
            return res.status(400).json({ success: false, message: 'يجب كتابة الرد الثابت أولاً' });
        }

        await MessengerPage.update(
            { 
                replyMode, 
                fixedReply: fixedReply?.trim() || null,
                useButtonsWithFixedReply: useButtonsWithFixedReply === true || useButtonsWithFixedReply === 'true',
                replyToMessagesWithFixed: replyToMessagesWithFixed !== false && replyToMessagesWithFixed !== 'false',
                replyToIgMessagesWithFixed: replyToIgMessagesWithFixed !== false && replyToIgMessagesWithFixed !== 'false'
            },
            { where: { pageId, UserId: req.user.id } }
        );

        const modeText = replyMode === 'ai' ? 'ذكاء اصطناعي' : 'رد ثابت';
        res.json({ success: true, message: `تم تفعيل نظام الـ ${modeText} بنجاح` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// حذف ربط جميع الصفحات
export async function disconnectAllPages(req, res) {
    try {
        await MessengerPage.destroy({ where: { UserId: req.user.id } });
        res.json({ success: true, message: 'تم إلغاء ربط جميع الصفحات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// جلب المحادثات لصفحة معينة
export async function getConversations(req, res) {
    try {
        const { pageId } = req.params;
        const conversations = await MessengerConversation.findAll({
            where: { pageId, UserId: req.user.id },
            order: [['lastMessageAt', 'DESC']],
            limit: 50
        });
        res.json({ success: true, conversations });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// جيب محادثة وعمل ملخص لها
export async function getSummary(req, res) {
    try {
        const { conversationId } = req.params;
        const summary = await generateConversationSummary(req.user.id, conversationId);
        res.json({ success: true, summary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// ======================================================
// Facebook OAuth - ابدأ عملية تسجيل الدخول بفيسبوك
// ======================================================
export function startFacebookAuth(req, res) {
    const appId = process.env.FB_APP_ID;
    const redirectUri = encodeURIComponent(process.env.FB_REDIRECT_URI);
    const scopes = [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_metadata',
        'pages_messaging',
        'pages_manage_engagement'
    ].join(',');

    // نحفظ الـ userId في الـ session عشان نستخدمه بعد الـ callback
    req.session.fbAuthUserId = req.user.id;

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scopes}&response_type=code`;
    res.redirect(authUrl);
}

// ======================================================
// Facebook OAuth - استقبال الـ callback بعد موافقة اليوزر
// ======================================================
export async function handleFacebookCallback(req, res) {
    const { code, error } = req.query;

    // لو اليوزر رفض أو حصل خطأ
    if (error || !code) {
        console.error('[Facebook OAuth] Error or denied:', error);
        return res.redirect('/dashboard/messenger?error=facebook_denied');
    }

    try {
        const appId = process.env.FB_APP_ID;
        const appSecret = process.env.FB_APP_SECRET;
        const redirectUri = encodeURIComponent(process.env.FB_REDIRECT_URI);
        const userId = req.session.fbAuthUserId || req.user?.id;

        if (!userId) {
            return res.redirect('/login');
        }

        // الخطوة 1: استبدل الـ code بـ User Access Token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${appId}&redirect_uri=${redirectUri}&client_secret=${appSecret}&code=${code}`
        );
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error('[Facebook OAuth] Failed to get token:', tokenData);
            return res.redirect('/dashboard/messenger?error=token_failed');
        }

        const userToken = tokenData.access_token;
        console.log('[Facebook OAuth] ✅ Got user access token');

        // الخطوة 2: جيب كل الصفحات اللي عند اليوزر
        const pagesRes = await fetch(
            `https://graph.facebook.com/v18.0/me/accounts?access_token=${userToken}&fields=id,name,access_token`
        );
        const pagesData = await pagesRes.json();

        if (!pagesData.data || pagesData.data.length === 0) {
            console.log('[Facebook OAuth] No pages found for user');
            return res.redirect('/dashboard/messenger?error=no_pages');
        }

        console.log(`[Facebook OAuth] Found ${pagesData.data.length} pages`);

        // الخطوة 3: احفظ كل صفحة في DB
        let savedCount = 0;
        for (const page of pagesData.data) {
            try {
                const [record, created] = await MessengerPage.findOrCreate({
                    where: { pageId: page.id },
                    defaults: {
                        UserId: userId,
                        pageId: page.id,
                        pageName: page.name,
                        accessToken: page.access_token,
                        isActive: true
                    }
                });

                if (!created) {
                    // حدّث الـ token لو الصفحة موجودة
                    await record.update({
                        pageName: page.name,
                        accessToken: page.access_token,
                        UserId: userId,
                        isActive: true
                    });
                }

                // 👉 تفعيل الـ Webhook للصفحة عشان يتبعت لنا الرسائل والكومنتات
                try {
                    const subscribeRes = await fetch(
                        `https://graph.facebook.com/v18.0/${page.id}/subscribed_apps`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                subscribed_fields: ['messages', 'messaging_postbacks', 'feed'],
                                access_token: page.access_token
                            })
                        }
                    );
                    const subscribeData = await subscribeRes.json();
                    if (subscribeData.success) {
                        console.log(`[Facebook OAuth] ✅ Subscribed to webhooks (messages + feed) for page: ${page.name}`);
                    } else {
                        console.error(`[Facebook OAuth] ⚠️ Failed to subscribe webhook for page ${page.id}:`, subscribeData.error);
                    }
                } catch (subErr) {
                    console.error(`[Facebook OAuth] ⚠️ Error subscribing webhook for page ${page.id}:`, subErr);
                }

                savedCount++;
                console.log(`[Facebook OAuth] ✅ Saved page: ${page.name} (${page.id})`);
            } catch (e) {
                console.error(`[Facebook OAuth] Failed to save page ${page.id}:`, e);
            }
        }

        // امسح الـ session variable
        delete req.session.fbAuthUserId;

        // ارجع للداشبورد مع رسالة نجاح
        res.redirect(`/dashboard/messenger?success=${savedCount}`);

    } catch (err) {
        console.error('[Facebook OAuth] Callback Error:', err);
        res.redirect('/dashboard/messenger?error=server_error');
    }
}

// ======================================================
// إرسال قائمة تفاعلية للماسنجر (Quick Replies)
// ======================================================
export async function sendMessengerInteractiveMenu(userId, recipientId, accessToken, menuId = null) {
    try {
        let menu;
        if (menuId) {
            menu = await InteractiveMenu.findOne({ where: { id: menuId, UserId: userId, isActive: true } });
        } else {
            menu = await InteractiveMenu.findOne({ where: { UserId: userId, isDefault: true, isActive: true } });
            if (!menu) {
                menu = await InteractiveMenu.findOne({
                    where: { UserId: userId, isActive: true },
                    order: [['createdAt', 'ASC']]
                });
            }
        }
        
        if (!menu) return false;

        const buttons = await InteractiveButton.findAll({
            where: { menuId: menu.id, isActive: true },
            order: [['order', 'ASC'], ['createdAt', 'ASC']]
        });

        if (buttons.length === 0) return false;

        const quickReplies = buttons.slice(0, 13).map(btn => ({
            content_type: 'text',
            title: btn.label.substring(0, 20),
            payload: `BTN_${btn.id}`
        }));

        const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                messaging_type: 'RESPONSE',
                message: {
                    text: menu.welcomeMessage || 'أهلاً بيك! 👋 اختار من القائمة:',
                    quick_replies: quickReplies
                }
            })
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Messenger] Send Quick Replies Error:', data.error);
            return false;
        }
        
        console.log(`✅ [Messenger] Quick Replies sent to ${recipientId}`);
        return true;
    } catch (err) {
        console.error('[Messenger] Send Quick Replies Exception:', err);
        return false;
    }
}

// ======================================================
// دالة مساعدة للحصول على القائمة التفاعلية كنص (للكومنتات)
// ======================================================
async function getInteractiveMenuText(userId) {
    try {
        let menu = await InteractiveMenu.findOne({ where: { UserId: userId, isDefault: true, isActive: true } });
        if (!menu) {
            menu = await InteractiveMenu.findOne({ where: { UserId: userId, isActive: true }, order: [['createdAt', 'ASC']] });
        }
        if (!menu) return null;

        const buttons = await InteractiveButton.findAll({
            where: { menuId: menu.id, isActive: true },
            order: [['order', 'ASC'], ['createdAt', 'ASC']]
        });

        if (buttons.length === 0) return null;

        let text = menu.welcomeMessage || 'أهلاً بيك! اختار من القائمة:\n';
        buttons.slice(0, 13).forEach(btn => {
            text += `\n- ${btn.label}`;
        });
        return text;
    } catch (e) {
        return null;
    }
}

// ======================================================
// دالة مساعدة للحصول على مصفوفة Quick Replies
// ======================================================
export async function getInteractiveMenuQuickReplies(userId) {
    try {
        let menu = await InteractiveMenu.findOne({ where: { UserId: userId, isDefault: true, isActive: true } });
        if (!menu) {
            menu = await InteractiveMenu.findOne({ where: { UserId: userId, isActive: true }, order: [['createdAt', 'ASC']] });
        }
        if (!menu) return null;

        const buttons = await InteractiveButton.findAll({
            where: { menuId: menu.id, isActive: true },
            order: [['order', 'ASC'], ['createdAt', 'ASC']]
        });

        if (buttons.length === 0) return null;

        return buttons.slice(0, 13).map(btn => ({
            content_type: 'text',
            title: btn.label.substring(0, 20),
            payload: `BTN_${btn.id}`
        }));
    } catch (e) {
        return null;
    }
}
