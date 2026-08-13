import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';
import Customer from './Customer.js';

const Notification = sequelize.define('Notification', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    type: {
        type: DataTypes.ENUM('customer_assigned', 'status_changed', 'payment_received', 'follow_up_due', 'system'),
        allowNull: false
    },
    title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    isRead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    targetUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف المستهدف بالإشعار'
    },
    CustomerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'customers',
            key: 'id'
        },
        comment: 'العميل المرتبط بالإشعار'
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
    tableName: 'notifications'
});

// Relationships
User.hasMany(Notification, { foreignKey: 'targetUserId', as: 'receivedNotifications', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'targetUserId', as: 'targetUser' });

Customer.hasMany(Notification, { foreignKey: 'CustomerId', onDelete: 'SET NULL' });
Notification.belongsTo(Customer, { foreignKey: 'CustomerId', as: 'customer' });

User.hasMany(Notification, { foreignKey: 'UserId', as: 'ownedNotifications', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default Notification;
