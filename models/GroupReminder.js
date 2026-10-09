import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const GroupReminder = sequelize.define('GroupReminder', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    groupJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'معرف جروب الواتساب'
    },
    groupSubject: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'اسم الجروب (تذكيرات)'
    },
    creatorPhone: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'رقم المشرف الذي أنشأ التذكير'
    },
    reminderText: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'نص التذكير'
    },
    targetEmployeeName: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'اسم الموظف المطلوب تذكيره (مثل ساهر)'
    },
    targetEmployeePhone: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'رقم تليفون الموظف'
    },
    targetEmployeeJid: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'معرف واتساب للموظف لعمل المنشن'
    },
    remindAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: 'موعد إرسال التذكير'
    },
    status: {
        type: DataTypes.ENUM('pending', 'sent', 'cancelled'),
        defaultValue: 'pending'
    },
    sentAt: {
        type: DataTypes.DATE,
        allowNull: true
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'صاحب النظام أو الحساب'
    }
}, {
    tableName: 'group_reminders'
});

// Relationships
User.hasMany(GroupReminder, { foreignKey: 'UserId', as: 'groupReminders', onDelete: 'CASCADE' });
GroupReminder.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default GroupReminder;
