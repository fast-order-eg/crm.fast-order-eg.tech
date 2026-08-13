import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const Campaign = sequelize.define('Campaign', {
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    platform: {
        type: DataTypes.ENUM('whatsapp', 'messenger'),
        defaultValue: 'whatsapp'
    },
    status: {
        type: DataTypes.ENUM('pending', 'running', 'completed', 'failed', 'cancelled'),
        defaultValue: 'pending'
    },
    targetFilter: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'فلتر الاستهداف {status: [], leadTemperature: [], filterDays: 0}'
    },
    contentType: {
        type: DataTypes.ENUM('text', 'image', 'video', 'link'),
        defaultValue: 'text'
    },
    mediaUrl: {
        type: DataTypes.STRING,
        allowNull: true
    },
    targetCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    sentCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    failedCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    deliveredCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    readCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    repliedCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    freezeAfter: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'تجميد الإرسال بعد إرسال N رسائل'
    },
    freezeDuration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'مدة تجميد الإرسال بالثواني'
    },
    scheduledAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'campaigns'
});

import User from './User.js';
Campaign.belongsTo(User);
User.hasMany(Campaign);

export default Campaign;
