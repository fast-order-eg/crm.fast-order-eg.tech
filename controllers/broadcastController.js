import Campaign from '../models/Campaign.js';
import MessengerPage from '../models/MessengerPage.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import MessengerConversation from '../models/MessengerConversation.js';
import Customer from '../models/Customer.js';
import { sendManualMessage } from './botController.js';
import { sendMessengerReply, sendMessengerMedia } from './messengerController.js';
import { Op } from 'sequelize';
import path from 'path';
import fs from 'fs';

// Helper for sessions Map
import { sessions } from './botController.js';

// Wait utility
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * دالة استخلاص العملاء المستهدفين للحملة بناءً على فلاتر الاستهداف
 */
export async function getCampaignTargets(platform, targetFilter, userId) {
    const whereClause = { UserId: userId };
    
    let filter = {};
    if (typeof targetFilter === 'string') {
        try { filter = JSON.parse(targetFilter); } catch (e) {}
    } else if (targetFilter) {
        filter = targetFilter;
    }

    const { status, leadTemperature, filterDays } = filter;

    if (filterDays && filterDays > 0) {
        const dateFilter = new Date();
        dateFilter.setDate(dateFilter.getDate() - parseInt(filterDays, 10));
        whereClause.lastMessageAt = { [Op.gte]: dateFilter };
    }

    if (platform === 'messenger') {
        // ماسنجر لا يدعم حالياً فلاتر الحالات لعدم وجود علاقة مباشرة مع Customer
        return await MessengerConversation.findAll({ where: whereClause });
    } else {
        // واتساب يدعم التصفية المتقدمة بالربط مع موديل Customer
        const customerWhere = {};
        if (status && status.length > 0) {
            customerWhere.status = { [Op.in]: status };
        }
        if (leadTemperature && leadTemperature.length > 0) {
            customerWhere.leadTemperature = { [Op.in]: leadTemperature };
        }

        const queryOptions = {
            where: whereClause
        };

        if (Object.keys(customerWhere).length > 0) {
            queryOptions.include = [{
                model: Customer,
                as: 'Customer',
                where: customerWhere,
                required: true
            }];
        } else {
            queryOptions.include = [{
                model: Customer,
                as: 'Customer',
                required: false
            }];
        }

        return await Conversation.findAll(queryOptions);
    }
}

/**
 * تشغيل الحملة وإرسال الرسائل للعملاء المستهدفين مع فواصل زمنية عشوائية
 */
export async function runBroadcastCampaign(campaignId, targets, messageText, userId, platform = 'whatsapp', minDelay = 30, maxDelay = 60, io = null) {
    try {
        let sent = 0;
        let failed = 0;

        // تحميل معلومات الحملة والميديا
        const campaign = await Campaign.findByPk(campaignId);
        if (!campaign) {
            console.error(`[Broadcast] Campaign ${campaignId} not found in DB`);
            return;
        }

        const { contentType, mediaUrl, freezeAfter, freezeDuration } = campaign;

        // تحميل صفحات ماسنجر إذا لزم الأمر
        const pageTokens = {};
        if (platform === 'messenger') {
            const pages = await MessengerPage.findAll({ where: { UserId: userId, isActive: true } });
            pages.forEach(p => pageTokens[p.pageId] = p.accessToken);
        }

        for (const target of targets) {
            // التحقق مما إذا كانت الحملة قد ألغيت
            const currentCampaign = await Campaign.findByPk(campaignId);
            if (!currentCampaign || currentCampaign.status === 'cancelled') {
                console.log(`Campaign ${campaignId} was cancelled.`);
                break;
            }

            try {
                let messageResponse = null;

                if (platform === 'whatsapp') {
                    if (!target.remoteJid) continue;
                    
                    const sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId));
                    if (!sock || !sock.user || sock.ws?.readyState !== 1) throw new Error("البوت غير متصل حالياً بالواتساب (جارٍ إعادة الاتصال).");

                    const messageContent = {};
                    if (contentType === 'text' || !mediaUrl) {
                        messageContent.text = messageText;
                    } else if (contentType === 'image') {
                        const absolutePath = mediaUrl.startsWith('http') ? mediaUrl : path.join(process.cwd(), 'public', mediaUrl);
                        messageContent.image = { url: absolutePath };
                        messageContent.caption = messageText;
                    } else if (contentType === 'video') {
                        const absolutePath = mediaUrl.startsWith('http') ? mediaUrl : path.join(process.cwd(), 'public', mediaUrl);
                        messageContent.video = { url: absolutePath };
                        messageContent.caption = messageText;
                    } else if (contentType === 'link') {
                        messageContent.text = `${messageText}\n\n${mediaUrl}`;
                    }

                    // إرسال عبر واتساب
                    messageResponse = await sock.sendMessage(target.remoteJid, messageContent);
                    sent++;

                    // حفظ الرسالة في قاعدة البيانات مع الـ CampaignId
                    const messageId = messageResponse?.key?.id || null;
                    await Message.create({
                        UserId: userId,
                        remoteJid: target.remoteJid,
                        role: 'model',
                        content: contentType === 'link' ? `${messageText}\n\n${mediaUrl}` : messageText,
                        media_url: ['image', 'video'].includes(contentType) ? mediaUrl : null,
                        CampaignId: campaignId,
                        messageId: messageId,
                        status: 'sent'
                    });

                } else if (platform === 'messenger') {
                    if (!target.senderId || !target.pageId) continue;
                    const token = pageTokens[target.pageId];
                    if (!token) throw new Error('No access token found for page');

                    const conversationId = `msng_${target.pageId}_${target.senderId}`;

                    // إرسال عبر ماسنجر
                    if (contentType === 'text' || !mediaUrl) {
                        messageResponse = await sendMessengerReply(target.senderId, messageText, token);
                    } else if (contentType === 'image' || contentType === 'video') {
                        messageResponse = await sendMessengerMedia(target.senderId, contentType, mediaUrl, token);
                    } else if (contentType === 'link') {
                        messageResponse = await sendMessengerReply(target.senderId, `${messageText}\n\n${mediaUrl}`, token);
                    }
                    sent++;

                    // حفظ الرسالة في قاعدة البيانات
                    const messageId = messageResponse?.message_id || null;
                    await Message.create({
                        UserId: userId,
                        remoteJid: conversationId,
                        role: 'model',
                        content: contentType === 'link' ? `${messageText}\n\n${mediaUrl}` : messageText,
                        media_url: ['image', 'video'].includes(contentType) ? mediaUrl : null,
                        CampaignId: campaignId,
                        messageId: messageId,
                        status: 'sent'
                    });
                }

                // تحديث الإحصائيات في قاعدة البيانات بعد الإرسال الناجح مباشرة
                await Campaign.update({ sentCount: sent, failedCount: failed }, { where: { id: campaignId } });
                
                // بث تحديث الإرسال عبر Socket.IO
                if (io) {
                    io.to(`user_${userId}`).emit('campaign_progress', {
                        campaignId,
                        status: 'running',
                        sentCount: sent,
                        failedCount: failed,
                        targetCount: targets.length
                    });
                }

            } catch (err) {
                console.error(`Failed to send broadcast to target:`, err?.message);
                failed++;
                
                // تحديث الإحصائيات في قاعدة البيانات بعد الفشل مباشرة
                await Campaign.update({ sentCount: sent, failedCount: failed }, { where: { id: campaignId } });
                
                if (io) {
                    io.to(`user_${userId}`).emit('campaign_progress', {
                        campaignId,
                        status: 'running',
                        sentCount: sent,
                        failedCount: failed,
                        targetCount: targets.length
                    });
                }
            }

            // الآن ننتظر الفاصل الزمني العادي أو فريز التبريد
            const totalProcessed = sent + failed;
            const isLastTarget = totalProcessed === targets.length;
            
            if (!isLastTarget) {
                // تحقق هل نحتاج تفعيل وضع التجميد (Freeze)
                if (freezeAfter > 0 && freezeDuration > 0 && totalProcessed % freezeAfter === 0) {
                    console.log(`[Campaign ${campaignId}] Freeze active: waiting ${freezeDuration}s after ${totalProcessed} messages...`);
                    for (let f = freezeDuration; f > 0; f--) {
                        // التحقق مما إذا كانت الحملة قد ألغيت أثناء التجميد
                        const checkCampaign = await Campaign.findByPk(campaignId);
                        if (!checkCampaign || checkCampaign.status === 'cancelled') {
                            break;
                        }
                        if (io) {
                            io.to(`user_${userId}`).emit('campaign_progress', {
                                campaignId,
                                status: 'freezing',
                                sentCount: sent,
                                failedCount: failed,
                                targetCount: targets.length,
                                freezeRemaining: f,
                                totalFreeze: freezeDuration
                            });
                        }
                        await delay(1000);
                    }
                } else {
                    // الفاصل العشوائي العادي
                    const waitTime = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
                    console.log(`[Campaign ${campaignId}] Waiting ${waitTime}s before next message...`);
                    for (let w = waitTime; w > 0; w--) {
                        // التحقق مما إذا كانت الحملة قد ألغيت أثناء الانتظار
                        const checkCampaign = await Campaign.findByPk(campaignId);
                        if (!checkCampaign || checkCampaign.status === 'cancelled') {
                            break;
                        }
                        if (io) {
                            io.to(`user_${userId}`).emit('campaign_progress', {
                                campaignId,
                                status: 'waiting_next',
                                sentCount: sent,
                                failedCount: failed,
                                targetCount: targets.length,
                                nextMessageIn: w,
                                totalDelay: waitTime
                            });
                        }
                        await delay(1000);
                    }
                }
            }
        }

        // التحديث النهائي عند اكتمال الإرسال أو الإلغاء
        const finalCampaign = await Campaign.findByPk(campaignId);
        let finalStatus = 'completed';
        if (finalCampaign && finalCampaign.status === 'cancelled') {
            finalStatus = 'cancelled';
        }

        await Campaign.update({
            status: finalStatus,
            sentCount: sent,
            failedCount: failed
        }, { where: { id: campaignId } });

        if (io) {
            io.to(`user_${userId}`).emit('campaign_progress', {
                campaignId: campaignId,
                status: finalStatus,
                sentCount: sent,
                failedCount: failed,
                targetCount: targets.length
            });
        }

        console.log(`Broadcast ${campaignId} completed. Status: ${finalStatus}. Sent: ${sent}, Failed: ${failed}`);

    } catch (error) {
        console.error(`Campaign ${campaignId} runtime error:`, error);
        await Campaign.update({ status: 'failed' }, { where: { id: campaignId } });
        if (io) {
            io.to(`user_${userId}`).emit('campaign_progress', {
                campaignId: campaignId,
                status: 'failed',
                sentCount: sent,
                failedCount: failed,
                targetCount: targets.length
            });
        }
    }
}

/**
 * فحص وإرسال الحملات المجدولة التي يحين موعدها
 */
export async function checkScheduledCampaigns(io) {
    try {
        const now = new Date();
        const pendingCampaigns = await Campaign.findAll({
            where: {
                status: 'pending',
                scheduledAt: {
                    [Op.lte]: now
                }
            }
        });

        for (const campaign of pendingCampaigns) {
            console.log(`⏰ [Broadcast] Starting scheduled campaign: "${campaign.name}" (ID: ${campaign.id})`);

            // تحديث الحالة فوراً لمنع التكرار
            campaign.status = 'running';
            await campaign.save();

            // جلب المستهدفين
            const targets = await getCampaignTargets(campaign.platform, campaign.targetFilter, campaign.UserId);
            
            if (targets.length === 0) {
                console.log(`⚠️ [Broadcast] No targets found for campaign ${campaign.id}. Setting status to completed.`);
                campaign.status = 'completed';
                await campaign.save();
                continue;
            }

            // تحديث إجمالي المستهدفين
            campaign.targetCount = targets.length;
            await campaign.save();

            // تشغيل البث في الخلفية مع تمرير io
            const delayMin = campaign.targetFilter?.minDelay || 30;
            const delayMax = campaign.targetFilter?.maxDelay || 60;
            runBroadcastCampaign(campaign.id, targets, campaign.message, campaign.UserId, campaign.platform, delayMin, delayMax, io)
                .catch(err => console.error(`Error running campaign ${campaign.id}:`, err));
        }
    } catch (error) {
        console.error('[Broadcast] Scheduled Campaigns check error:', error);
    }
}
