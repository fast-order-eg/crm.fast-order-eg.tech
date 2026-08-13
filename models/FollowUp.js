import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import Customer from './Customer.js';
import User from './User.js';

const FollowUp = sequelize.define('FollowUp', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    CustomerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'customers',
            key: 'id'
        }
    },
    type: {
        type: DataTypes.ENUM('first', 'final', 'scheduled', 'no_action'),
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('pending', 'sent', 'replied', 'expired'),
        defaultValue: 'pending'
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'نص الرسالة المراد إرسالها'
    },
    scheduledAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: 'موعد الإرسال'
    },
    sentAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    repliedAt: {
        type: DataTypes.DATE,
        allowNull: true
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
    tableName: 'follow_ups'
});

// Relationships
Customer.hasMany(FollowUp, { foreignKey: 'CustomerId', as: 'followUps', onDelete: 'CASCADE' });
FollowUp.belongsTo(Customer, { foreignKey: 'CustomerId', as: 'customer' });

User.hasMany(FollowUp, { foreignKey: 'UserId', as: 'followUps', onDelete: 'CASCADE' });
FollowUp.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default FollowUp;
