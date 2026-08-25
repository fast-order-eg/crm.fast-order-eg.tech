import 'dotenv/config';
import Customer from '../models/Customer.js';
import Message from '../models/Message.js';
import { Op } from 'sequelize';

async function run() {
    const cust = await Customer.findOne({
        where: {
            [Op.or]: [
                { phoneNumber: '201001531312' },
                { customerNumber: 191 }
            ]
        }
    });

    console.log('--- CUSTOMER ---');
    console.log(cust ? cust.toJSON() : 'Not found');

    if (cust) {
        const msgs = await Message.findAll({
            where: {
                [Op.or]: [
                    { remoteJid: cust.remoteJid },
                    { remoteJid: `${cust.phoneNumber}@s.whatsapp.net` },
                    { remoteJid: cust.phoneNumber }
                ]
            },
            order: [['createdAt', 'ASC']]
        });

        console.log(`--- MESSAGES (${msgs.length}) ---`);
        for (const m of msgs) {
            console.log(`[${m.createdAt}] ID: ${m.messageId} | Role: ${m.role} | Status: ${m.status} | Content: ${m.content.substring(0, 80)}`);
        }
    }
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
