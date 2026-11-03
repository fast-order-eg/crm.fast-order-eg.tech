import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const BusinessObserverGroup = sequelize.define('BusinessObserverGroup', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    groupJid: {
        type: DataTypes.STRING(191),
        allowNull: false,
        comment: 'معرف جروب الواتساب'
    },
    groupName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'اسم الجروب'
    },
    groupDescription: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'طبيعة وتعليمات الجروب (مثال: جروب خدمة عملاء ديفو، جروب الشحن)'
    },
    isMonitored: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        }
    }
}, {
    tableName: 'business_observer_groups',
    timestamps: true,
    indexes: [
        { fields: ['groupJid'] },
        { fields: ['UserId'] }
    ]
});

User.hasMany(BusinessObserverGroup, { foreignKey: 'UserId', as: 'monitoredGroups', onDelete: 'CASCADE' });
BusinessObserverGroup.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

export default BusinessObserverGroup;
