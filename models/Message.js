import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const Message = sequelize.define('Message', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    remoteJid: {
        type: DataTypes.STRING,
        allowNull: false
    },
    role: {
        type: DataTypes.ENUM('user', 'model'),
        allowNull: false
    },
    content: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    senderName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    media_url: {
        type: DataTypes.STRING,
        allowNull: true
    },
    messageId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    status: {
        type: DataTypes.ENUM('sent', 'delivered', 'read'),
        defaultValue: 'sent'
    },
    replied: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    CampaignId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'campaigns',
            key: 'id'
        }
    }
}, {
    tableName: 'messages',
    hooks: {
        afterCreate: async (message) => {
            if (message.role === 'model') {
                try {
                    const CustomerModule = await import('./Customer.js');
                    const Customer = CustomerModule.default;
                    await Customer.update(
                        { lastBotMessageAt: message.createdAt || new Date() },
                        { where: { UserId: message.UserId, remoteJid: message.remoteJid } }
                    );
                } catch (err) {
                    console.error('Error updating lastBotMessageAt in Message hook:', err);
                }
            }

            // Update Conversation lastMessageText, lastMessageAt, and summary_sent
            try {
                const ConversationModule = await import('./Conversation.js');
                const Conversation = ConversationModule.default;
                await Conversation.update(
                    { 
                        lastMessageText: message.content, 
                        lastMessageAt: message.createdAt || new Date(),
                        summary_sent: false
                    },
                    { where: { UserId: message.UserId, remoteJid: message.remoteJid } }
                );
            } catch (err) {
                console.error('Error updating Conversation in Message hook:', err);
            }
        }
    }
});

// Relationships
User.hasMany(Message, { onDelete: 'CASCADE' });
Message.belongsTo(User);

import Campaign from './Campaign.js';
Campaign.hasMany(Message, { onDelete: 'SET NULL' });
Message.belongsTo(Campaign);

export default Message;
