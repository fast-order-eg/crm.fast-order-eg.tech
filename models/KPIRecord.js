import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const KPIRecord = sequelize.define('KPIRecord', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    employeeUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف المسؤول'
    },
    period: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'YYYY-MM-DD (يومي) أو YYYY-MM (شهري)'
    },
    periodType: {
        type: DataTypes.ENUM('daily', 'monthly'),
        allowNull: false,
        defaultValue: 'daily'
    },
    messagesReceived: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'إجمالي الرسائل المستلمة'
    },
    customersReceived: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'العملاء المخصصين'
    },
    customersContacted: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'العملاء الذين تم الرد عليهم لأول مرة'
    },
    contractsClosed: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'العقود المغلقة'
    },
    revenue: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.00,
        comment: 'الإيرادات المحققة'
    },
    statusUpdates: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'تحديثات الحالة'
    },
    totalResponseTimeMs: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: 'إجمالي وقت الرد بالمللي ثانية'
    },
    responseCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'عدد الردود لحساب المتوسط'
    },
    fastestResponseMs: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'أسرع استجابة بالمللي ثانية'
    },
    slowestResponseMs: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'أبطأ استجابة بالمللي ثانية'
    },
    lateResponses: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'الردود المتأخرة (>30 دقيقة)'
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
    tableName: 'kpi_records',
    indexes: [
        {
            unique: true,
            fields: ['UserId', 'employeeUserId', 'period', 'periodType']
        }
    ]
});

// Relationships
User.hasMany(KPIRecord, { foreignKey: 'employeeUserId', as: 'kpiRecords', onDelete: 'CASCADE' });
KPIRecord.belongsTo(User, { foreignKey: 'employeeUserId', as: 'employee' });

User.hasMany(KPIRecord, { foreignKey: 'UserId', as: 'ownedKPIRecords', onDelete: 'CASCADE' });
KPIRecord.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

export default KPIRecord;
