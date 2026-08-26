import 'dotenv/config';
import Message from '../models/Message.js';
import { Op } from 'sequelize';

async function run() {
    const phones = ['201287349724', '201501188050', '201066323598', '201098772533', '201001531312'];
    for (const p of phones) {
        const msgs = await Message.findAll({
            where: {
                remoteJid: { [Op.like]: `%${p}%` }
            },
            order: [['createdAt', 'ASC']]
        });
        console.log(`\n=== PHONE: ${p} (${msgs.length} messages) ===`);
        for (const m of msgs) {
            console.log(`[${m.createdAt.toISOString()}] Role: ${m.role} | Status: ${m.status} | ID: ${m.messageId} | Text: ${m.content ? m.content.substring(0, 50) : ''}`);
        }
    }
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
