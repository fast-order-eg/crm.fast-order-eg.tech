import 'dotenv/config';
import axios from 'axios';
import Customer from '../models/Customer.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { handleFunnelStep, sendInteractiveButtons, handleButtonResponse } from './botController.js';

// Webhook Verification (GET /api/whatsapp/meta-webhook)
export const verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'fastorder_meta_verify_2026')) {
            console.log('✅ [META_WEBHOOK] Verified successfully!');
            return res.status(200).send(challenge);
        } else {
            console.error('❌ [META_WEBHOOK] Token mismatch:', token);
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
};

// Send Message via Meta Graph API (Text, Buttons, List, Template)
export const sendMetaMessage = async (to, bodyText, options = {}) => {
    try {
        const phoneId = process.env.META_PHONE_NUMBER_ID || '1187785914426370';
        const accessToken = process.env.META_ACCESS_TOKEN;
        console.log(`🔍 [META_SEND_DEBUG] PhoneId: ${phoneId}, Token Len: ${accessToken ? accessToken.length : 0}, Token Prefix: ${accessToken ? accessToken.substring(0, 20) : 'NONE'}`);
        let cleanTo = String(to || '').replace(/[^0-9]/g, '');
        if (cleanTo.length === 11 && cleanTo.startsWith('01')) {
            cleanTo = '2' + cleanTo;
        } else if (cleanTo.length === 10 && (cleanTo.startsWith('10') || cleanTo.startsWith('11') || cleanTo.startsWith('12') || cleanTo.startsWith('15'))) {
            cleanTo = '20' + cleanTo;
        }

        let payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
        };

        if (options.mediaUrl && options.mediaType) {
            // Media Message (image, audio, video, document)
            payload.type = options.mediaType;
            const fullLink = options.mediaUrl.startsWith('http') ? options.mediaUrl : `https://crm.fast-order-eg.tech${options.mediaUrl}`;
            
            if (options.mediaType === 'image') {
                payload.image = { link: fullLink };
                if (bodyText) payload.image.caption = bodyText;
            } else if (options.mediaType === 'audio') {
                payload.audio = { link: fullLink };
            } else if (options.mediaType === 'video') {
                payload.video = { link: fullLink };
                if (bodyText) payload.video.caption = bodyText;
            } else if (options.mediaType === 'document') {
                payload.document = { link: fullLink, filename: options.filename || 'file' };
                if (bodyText) payload.document.caption = bodyText;
            }
        } else if (options.template) {
            // Template Message
            payload.type = 'template';
            payload.template = typeof options.template === 'string' 
                ? { name: options.template, language: { code: options.language || 'ar' } }
                : options.template;
        } else if (options.buttons && Array.isArray(options.buttons) && options.buttons.length > 0) {
            // Interactive Quick Reply Buttons (Max 3 buttons according to Meta API)
            payload.type = 'interactive';
            payload.interactive = {
                type: 'button',
                body: { text: bodyText },
                action: {
                    buttons: options.buttons.slice(0, 3).map((btn, index) => ({
                        type: 'reply',
                        reply: {
                            id: btn.id || `btn_${index + 1}`,
                            title: String(btn.title || btn.text || btn).substring(0, 20) // Meta max 20 chars
                        }
                    }))
                }
            };
            if (options.header) payload.interactive.header = { type: 'text', text: options.header };
            if (options.footer) payload.interactive.footer = { text: options.footer };
        } else if (options.sections && Array.isArray(options.sections)) {
            // Interactive List Menu
            payload.type = 'interactive';
            payload.interactive = {
                type: 'list',
                body: { text: bodyText },
                action: {
                    button: options.buttonTitle || 'اختر من القائمة',
                    sections: options.sections
                }
            };
            if (options.header) payload.interactive.header = { type: 'text', text: options.header };
            if (options.footer) payload.interactive.footer = { text: options.footer };
        } else {
            // Plain Text Message
            payload.type = 'text';
            payload.text = { preview_url: false, body: bodyText };
        }

        const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ [META_SEND_SUCCESS] Message sent to ${cleanTo}`);
        return { success: true, data: response.data };
    } catch (err) {
        console.error('❌ [META_SEND_ERROR]:', err.response?.data || err.message);
        return { success: false, error: err.response?.data || err.message };
    }
};

// Handle Incoming Webhook Events (POST /api/whatsapp/meta-webhook)
export const handleWebhook = async (req, res) => {
    res.sendStatus(200);

    // Get Socket.IO instance from Express app
    const io = req.app.get('socketio');

    try {
        const body = req.body;
        console.log('📨 [META_WEBHOOK_RAW] Full event received:', JSON.stringify(body, null, 2));

        const entry = body?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;

        if (!value) return;

        // Handle message status updates (sent, delivered, read, failed)
        if (value.statuses && value.statuses.length > 0) {
            const status = value.statuses[0];
            console.log(`📊 [META_STATUS] Message ${status.id} -> ${status.status}`);

            try {
                await Message.update(
                    { status: status.status },
                    { where: { messageId: status.id } }
                );
            } catch (err) {
                console.error('Error updating message status in DB:', err.message);
            }

            if (io) {
                io.emit('message_status', {
                    messageId: status.id,
                    status: status.status
                });
            }
            return;
        }

        if (value.messages && value.messages.length > 0) {
            const msg = value.messages[0];
            const contact = value.contacts?.[0];
            const rawFrom = String(msg.from || '').trim();
            
            if (!rawFrom) {
                console.log(`⚠️ [META_WEBHOOK] Skipped message with empty sender identifier.`);
                return;
            }

            const digitsOnly = rawFrom.replace(/[^0-9]/g, '');
            const isPhone = digitsOnly.length >= 5;
            const targetId = isPhone ? digitsOnly : rawFrom;
            const remoteJid = isPhone ? `${digitsOnly}@s.whatsapp.net` : (rawFrom.includes('@') ? rawFrom : `${rawFrom}@s.whatsapp.net`);

            const senderName = contact?.profile?.name || (isPhone ? `عميل ${digitsOnly}` : `عميل ${rawFrom}`);
            // Primary Admin User ID for Meta API (User rady = ID 3)
            const activeAdmin = await User.findOne({ where: { username: 'rady' } });
            const userId = activeAdmin ? activeAdmin.id : 3;

            let textContent = '';
            let mediaUrl = null;
            let buttonId = null;

            if (msg.type === 'text') {
                textContent = msg.text.body;
            } else if (msg.type === 'audio' || msg.type === 'voice') {
                const audioObj = msg.audio || msg.voice;
                if (audioObj && audioObj.id) {
                    mediaUrl = `/api/whatsapp/meta-media/${audioObj.id}`;
                }
                textContent = '🎤 [رسالة صوتية]';
            } else if (msg.type === 'image') {
                if (msg.image && msg.image.id) {
                    mediaUrl = `/api/whatsapp/meta-media/${msg.image.id}`;
                }
                textContent = msg.image?.caption || '📷 [صورة]';
            } else if (msg.type === 'video') {
                if (msg.video && msg.video.id) {
                    mediaUrl = `/api/whatsapp/meta-media/${msg.video.id}`;
                }
                textContent = msg.video?.caption || '🎥 [فيديو]';
            } else if (msg.type === 'document') {
                if (msg.document && msg.document.id) {
                    mediaUrl = `/api/whatsapp/meta-media/${msg.document.id}`;
                }
                textContent = msg.document?.filename || '📄 [ملف]';
            } else if (msg.type === 'sticker') {
                if (msg.sticker && msg.sticker.id) {
                    mediaUrl = `/api/whatsapp/meta-media/${msg.sticker.id}`;
                }
                textContent = '🎨 [ملصق]';
            } else if (msg.type === 'button') {
                textContent = msg.button.text;
                buttonId = msg.button.payload;
            } else if (msg.type === 'interactive') {
                if (msg.interactive?.type === 'button_reply') {
                    textContent = msg.interactive.button_reply.title;
                    buttonId = msg.interactive.button_reply.id;
                } else if (msg.interactive?.type === 'list_reply') {
                    textContent = msg.interactive.list_reply.title;
                    buttonId = msg.interactive.list_reply.id;
                } else {
                    textContent = 'تفاعل زائر';
                }
            } else {
                textContent = `[رسالة ${msg.type}]`;
            }

            console.log(`📩 [META_INCOMING] From ${senderName} (${targetId}): ${textContent}`);

            // Update User connection_status to meta_online
            try {
                await User.update(
                    { connection_status: 'meta_online', auto_reply: true },
                    { where: { id: userId } }
                );
                console.log('✅ [META_STATUS] User connection_status updated to meta_online');
                if (io) {
                    io.to(`user_${userId}`).emit('status', { status: 'meta_online' });
                }
            } catch (statusErr) {
                console.error('⚠️ [META_STATUS_UPDATE_ERROR]:', statusErr.message);
            }

            // Find or Create Customer
            let [customer] = await Customer.findOrCreate({
                where: { UserId: userId, remoteJid: remoteJid },
                defaults: {
                    UserId: userId,
                    phoneNumber: targetId,
                    customerName: senderName,
                    remoteJid: remoteJid,
                    status: 'new',
                    firstContactAt: new Date(),
                    lastReplyAt: new Date()
                }
            });

            // Auto-merge any temporary Baileys LID duplicate customer into real customer
            try {
                const { autoMergeDuplicateCustomers } = await import('../services/assignmentService.js');
                await autoMergeDuplicateCustomers(userId, targetId, remoteJid, senderName);
            } catch (mergeErr) {
                console.error('⚠️ [LID_MERGE_ERROR]:', mergeErr.message);
            }

            // Find or Create Conversation
            let [conversation] = await Conversation.findOrCreate({
                where: { UserId: userId, remoteJid: remoteJid },
                defaults: {
                    UserId: userId,
                    remoteJid: remoteJid,
                    phoneNumber: isPhone ? targetId : null,
                    customerName: senderName,
                    CustomerId: customer.id,
                    platform: 'whatsapp',
                    lastMessageText: textContent,
                    lastMessageAt: new Date()
                }
            });

            // Save Incoming Message
            const savedIncomingMsg = await Message.create({
                UserId: userId,
                remoteJid: remoteJid,
                role: 'user',
                content: textContent,
                senderName: senderName,
                media_url: mediaUrl,
                status: 'delivered'
            });

            // Emit incoming message to Live Chat via Socket.IO
            if (io) {
                io.to(`user_${userId}`).emit('new_message', savedIncomingMsg);
                console.log(`📡 [META_SOCKET] Emitted new_message to user_${userId} for Live Chat`);
            }

            await conversation.update({
                lastMessageText: textContent,
                lastMessageAt: new Date(),
                summary_sent: false
            });
            await customer.update({ lastReplyAt: new Date() });

            // Create metaSock adapter for Meta Cloud API sending
            const metaSock = {
                user: { id: '1187785914426370@s.whatsapp.net', name: 'Fast Order' },
                sendPresenceUpdate: async () => {},
                sendMessage: async (jid, content) => {
                    const cleanTo = jid.replace(/[^0-9]/g, '');
                    let result;
                    let sentText = '';
                    
                    if (typeof content === 'string') {
                        sentText = content;
                        result = await sendMetaMessage(cleanTo, content);
                    } else if (content && content.text) {
                        sentText = content.text;
                        let opts = {};
                        if (content.buttons && Array.isArray(content.buttons) && content.buttons.length > 0) {
                            if (content.buttons.length <= 3) {
                                opts.buttons = content.buttons;
                            } else {
                                // Meta List Menu for > 3 buttons (up to 10)
                                opts.buttonTitle = 'اختر الخدمة 📋';
                                opts.sections = [{
                                    title: 'قائمة الخدمات المتاحة',
                                    rows: content.buttons.slice(0, 10).map((btn, idx) => ({
                                        id: String(btn.id || btn.buttonId || `btn_${idx + 1}`),
                                        title: String(btn.title || btn.label || btn).substring(0, 24)
                                    }))
                                }];
                            }
                        }
                        result = await sendMetaMessage(cleanTo, content.text, opts);
                    } else if (content && content.caption) {
                        sentText = content.caption;
                        result = await sendMetaMessage(cleanTo, content.caption);
                    } else {
                        sentText = String(content);
                        result = await sendMetaMessage(cleanTo, sentText);
                    }
                    return result;
                }
            };

            // Trigger Bot Auto-Reply (Interactive Buttons / List Menu or Funnel Step)
            try {
                console.log(`🤖 [META_BOT] Processing incoming message from ${targetId}...`);
                if (buttonId) {
                    console.log(`🔘 [META_BOT] Button/List selection received: ${buttonId}`);
                    await handleButtonResponse(metaSock, remoteJid, buttonId, userId, io, targetId);
                } else {
                    console.log(`📋 [META_BOT] Sending interactive menu for ${targetId}...`);
                    const sentMenu = await sendInteractiveButtons(metaSock, remoteJid, userId, io, null, senderName);
                    if (!sentMenu) {
                        console.log(`🔄 [META_BOT] Fallback to funnel step for ${targetId}...`);
                        await handleFunnelStep(metaSock, remoteJid, customer, textContent, msg, io);
                    }
                }
            } catch (botErr) {
                console.error('❌ [META_BOT_ERROR]:', botErr);
            }
        }
    } catch (err) {
        console.error('❌ [META_WEBHOOK_HANDLER_ERROR]:', err);
    }
};

/**
 * Proxy controller to stream Meta Cloud API Media files (Audio, Images, Videos, Documents)
 */
export const getMetaMedia = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const accessToken = process.env.META_ACCESS_TOKEN;
        if (!mediaId || !accessToken) {
            return res.status(400).send('Media ID or Access Token missing');
        }

        // 1. Get Media URL from Meta Graph API
        const metaRes = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const mediaUrl = metaRes.data?.url;
        const mimeType = metaRes.data?.mime_type || 'application/octet-stream';

        if (!mediaUrl) {
            return res.status(404).send('Media URL not found from Meta');
        }

        // 2. Download and stream the media file directly to the client
        const mediaStream = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', mimeType);
        mediaStream.data.pipe(res);
    } catch (err) {
        console.error('❌ [META_MEDIA_PROXY_ERROR]:', err.response?.data || err.message);
        res.status(500).send('Failed to stream Meta media file');
    }
};
