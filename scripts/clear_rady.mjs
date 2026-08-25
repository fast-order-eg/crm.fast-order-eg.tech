import 'dotenv/config';
import User from '../models/User.js';

async function run() {
    await User.update({ notificationPhone: null }, { where: { username: 'rady' } });
    console.log('Successfully cleared notificationPhone for rady!');
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
