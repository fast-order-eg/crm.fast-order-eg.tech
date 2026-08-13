import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';
import Customer from './Customer.js';

const ChangeLog = sequelize.define('ChangeLog', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    action: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'نوع الإجراء (status_change, note_added, customer_assigned, data_edited)'
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'وصف الإجراء بالعربي'
    },
    oldValue: {
        type: DataTypes.STRING,
        allowNull: true
    },
    newValue: {
        type: DataTypes.STRING,
        allowNull: true
    },
    CustomerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'customers',
            key: 'id'
        }
    },
    performedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف الذي قام بالإجراء'
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
    tableName: 'changelogs'
});

// Relationships
Customer.hasMany(ChangeLog, { foreignKey: 'CustomerId', onDelete: 'SET NULL' });
ChangeLog.belongsTo(Customer, { foreignKey: 'CustomerId', as: 'customer' });

User.hasMany(ChangeLog, { foreignKey: 'performedByUserId', as: 'performedLogs', onDelete: 'SET NULL' });
ChangeLog.belongsTo(User, { foreignKey: 'performedByUserId', as: 'performer' });

User.hasMany(ChangeLog, { foreignKey: 'UserId', as: 'ownerLogs', onDelete: 'CASCADE' });
ChangeLog.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default ChangeLog;
