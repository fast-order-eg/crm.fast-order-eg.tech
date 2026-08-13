import sequelize from './config/database.js';
import { DataTypes } from 'sequelize';

async function run() {
    try {
        await sequelize.query("ALTER TABLE messages ADD COLUMN senderName VARCHAR(255);");
        console.log("Success");
    } catch (e) {
        console.log("Error:", e.message);
    }
    process.exit();
}
run();
