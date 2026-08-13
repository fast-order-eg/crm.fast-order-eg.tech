import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const SystemSettings = sequelize.define('SystemSettings', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    settingKey: {
        type: DataTypes.STRING,
        allowNull: false
    },
    settingValue: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    settingType: {
        type: DataTypes.ENUM('text', 'number', 'json', 'boolean'),
        defaultValue: 'text',
        allowNull: false
    },
    category: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'messages, timers, payment, buttons, general'
    },
    label: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'عنوان الإعداد بالعربي'
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'صاحب البوت (owner)'
    }
}, {
    tableName: 'system_settings',
    indexes: [
        {
            unique: true,
            fields: ['UserId', 'settingKey']
        }
    ]
});

// Relationships
User.hasMany(SystemSettings, { foreignKey: 'UserId', as: 'systemSettings', onDelete: 'CASCADE' });
SystemSettings.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default SystemSettings;
