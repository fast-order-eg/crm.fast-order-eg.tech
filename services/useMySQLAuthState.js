import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import BaileysSession from '../models/BaileysSession.js';

export const useMySQLAuthState = async (userId) => {
    const credsKey = `creds`;

    // Fetch creds from DB
    const existingCredsRecord = await BaileysSession.findByPk(`user_${userId}_${credsKey}`);
    let creds;
    if (existingCredsRecord) {
        try {
            creds = JSON.parse(existingCredsRecord.data, BufferJSON.reviver);
        } catch (err) {
            console.error(`⚠️ [MySQL_AUTH] Error parsing creds for user ${userId}, re-initializing:`, err);
            creds = initAuthCreds();
        }
    } else {
        creds = initAuthCreds();
        await BaileysSession.create({
            id: `user_${userId}_${credsKey}`,
            userId,
            data: JSON.stringify(creds, BufferJSON.replacer)
        });
    }

    const writeData = async (data, key) => {
        const id = `user_${userId}_${key}`;
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await BaileysSession.upsert({ id, userId, data: serialized });
    };

    const readData = async (key) => {
        const id = `user_${userId}_${key}`;
        const record = await BaileysSession.findByPk(id);
        if (!record) return null;
        try {
            return JSON.parse(record.data, BufferJSON.reviver);
        } catch (err) {
            return null;
        }
    };

    const removeData = async (key) => {
        const id = `user_${userId}_${key}`;
        await BaileysSession.destroy({ where: { id } });
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        },
        clearState: async () => {
            await BaileysSession.destroy({ where: { userId } });
        }
    };
};
