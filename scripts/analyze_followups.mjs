import 'dotenv/config';
import Customer from '../models/Customer.js';
import Message from '../models/Message.js';
import FollowUp from '../models/FollowUp.js';
import { Op } from 'sequelize';

async function run() {
    console.log('=== 1. CHECK SPECIFIC CUSTOMER: 201287349724 ===');
    const targetCust = await Customer.findOne({
        where: {
            phoneNumber: { [Op.like]: '%1287349724%' }
        }
    });

    if (targetCust) {
        console.log('Target Customer:', {
            id: targetCust.id,
            customerNumber: targetCust.customerNumber,
            name: targetCust.customerName,
            phone: targetCust.phoneNumber,
            status: targetCust.status,
            firstContactAt: targetCust.firstContactAt,
            lastReplyAt: targetCust.lastReplyAt,
            createdAt: targetCust.createdAt,
            updatedAt: targetCust.updatedAt
        });

        const msgs = await Message.findAll({
            where: {
                [Op.or]: [
                    { remoteJid: targetCust.remoteJid },
                    { remoteJid: `${targetCust.phoneNumber}@s.whatsapp.net` },
                    { remoteJid: targetCust.phoneNumber }
                ]
            },
            order: [['createdAt', 'ASC']]
        });

        console.log(`Messages (${msgs.length}):`);
        for (const m of msgs) {
            console.log(`- [${m.createdAt}] ID: ${m.messageId} | Role: ${m.role} | Status: ${m.status} | Content: ${m.content ? m.content.substring(0, 70) : ''}`);
        }
    }

    console.log('\n=== 2. LAST 10 FOLLOW-UPS ANALYSIS ===\n');
    const lastFollowups = await FollowUp.findAll({
        order: [['createdAt', 'DESC']],
        limit: 10,
        include: [{ model: Customer, as: 'customer' }]
    });

    let index = 1;
    for (const f of lastFollowups) {
        const cust = f.customer;
        if (!cust) continue;

        const firstContact = new Date(cust.firstContactAt || cust.createdAt);
        const sentTime = new Date(f.sentAt || f.createdAt);
        const diffHours = ((sentTime - firstContact) / (1000 * 60 * 60)).toFixed(1);
        const isUnder72Hours = (sentTime - firstContact) <= (72 * 60 * 60 * 1000);

        console.log(`[#${index++}] العميل: ${cust.customerName || 'بدون اسم'} | 📱 الرقم: ${cust.phoneNumber} | كود: ${cust.customerNumber}`);
        console.log(`   - نوع المتابعة: ${f.type === 'first' ? 'متابعة أولى' : 'متابعة نهائية'}`);
        console.log(`   - وقت أول تواصل: ${firstContact.toISOString()}`);
        console.log(`   - وقت الإرسال: ${sentTime.toISOString()}`);
        console.log(`   - المدة من أول تواصل: ${diffHours} ساعة (أقل من 72 ساعة؟ ${isUnder72Hours ? '✅ نعم - مجاني' : '❌ لا - مدفوع'})`);
        console.log(`   - حالة المتابعة في السجل: ${f.status}`);

        // Find the actual message sent to this customer around or after sentTime
        const msgs = await Message.findAll({
            where: {
                remoteJid: { [Op.or]: [cust.remoteJid, `${cust.phoneNumber}@s.whatsapp.net`, cust.phoneNumber] },
                role: 'model'
            },
            order: [['createdAt', 'DESC']],
            limit: 2
        });

        if (msgs.length > 0) {
            const m = msgs[0];
            console.log(`   - الرسالة في الشات: [${m.createdAt.toISOString()}]`);
            console.log(`   - Message ID: ${m.messageId || 'NULL'}`);
            console.log(`   - حالة الرسالة الحقيقية: ${m.status === 'read' ? '👀 مقروءة (Read)' : (m.status === 'delivered' ? '📬 استلمت (Delivered)' : (m.status === 'sent' ? '📤 أرسلت (Sent)' : '❌ فشلت (Failed)'))}`);
            console.log(`   - جزء من النص: ${m.content ? m.content.substring(0, 60) : ''}...`);
        } else {
            console.log(`   - لا توجد رسالة مقابلة في جدول Messages`);
        }
        console.log('--------------------------------------------------------------------------------');
    }

    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
