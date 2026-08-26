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
    } else {
        console.log('Customer 201287349724 not found!');
    }

    console.log('\n=== 2. LAST 10 FOLLOW-UPS ===');
    const lastFollowups = await FollowUp.findAll({
        order: [['createdAt', 'DESC']],
        limit: 10,
        include: [{ model: Customer }]
    });

    for (const f of lastFollowups) {
        const cust = f.Customer;
        console.log(`\n--- FollowUp ID: ${f.id} | Type: ${f.type} | SentAt: ${f.sentAt || f.createdAt} ---`);
        console.log(`Customer: ${cust ? `${cust.customerName} (${cust.phoneNumber}) [Code: ${cust.customerNumber}]` : 'N/A'}`);
        console.log(`First Contact: ${cust?.firstContactAt}, Last Reply: ${cust?.lastReplyAt}`);
        console.log(`FollowUp Status in DB: ${f.status}`);
        
        // Find associated message in messages table
        if (cust) {
            const relatedMsgs = await Message.findAll({
                where: {
                    remoteJid: { [Op.or]: [cust.remoteJid, `${cust.phoneNumber}@s.whatsapp.net`, cust.phoneNumber] },
                    role: 'model'
                },
                order: [['createdAt', 'DESC']],
                limit: 3
            });
            for (const rm of relatedMsgs) {
                console.log(`  -> Msg in DB: [${rm.createdAt}] ID: ${rm.messageId} | Status: ${rm.status} | Content: ${rm.content?.substring(0, 50)}`);
            }
        }
    }

    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
