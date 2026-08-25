import 'dotenv/config';
import User from '../models/User.js';
import BaileysSession from '../models/BaileysSession.js';

async function run() {
    const users = await User.findAll();
    console.log('USERS:');
    for (const u of users) {
        console.log({
            id: u.id,
            username: u.username,
            phone: u.phone,
            notificationPhone: u.notificationPhone,
            linked_phone_number: u.linked_phone_number,
            connection_status: u.connection_status,
            auto_reply: u.auto_reply
        });
    }
    
    const sessions = await BaileysSession.findAll();
    console.log(`TOTAL BAILEYS SESSIONS IN DB: ${sessions.length}`);
    for (const s of sessions) {
        if (s.id.includes('creds')) {
            console.log(`Session creds key: ${s.id}, userId: ${s.userId}`);
        }
    }
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
