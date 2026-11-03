import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const BusinessObserverEmployee = sequelize.define('BusinessObserverEmployee', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'اسم الموظف'
    },
    phone: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'رقم هاتف الموظف'
    },
    role: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: 'موظف',
        comment: 'الدور الوظيفي (مبيعات، خدمة عملاء، شحن، ميديا باير، إدارة)'
    },
    rating: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'التقييم العام ورأي الإدارة / AI (مثل: 8.5/10 - ممتاز)'
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'ملاحظات أو مهام الموظف'
    },
    evaluation: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'الملاحظات التحليلية والتقييم النهائي للأداء'
    },
    evidence: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'الإثبات والدليل والشواهد من المحادثات والجروبات'
    },
    isActive: {
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
    tableName: 'business_observer_employees',
    timestamps: true,
    indexes: [
        { fields: ['phone'] },
        { fields: ['UserId'] }
    ]
});

User.hasMany(BusinessObserverEmployee, { foreignKey: 'UserId', as: 'monitoredEmployees', onDelete: 'CASCADE' });
BusinessObserverEmployee.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

export default BusinessObserverEmployee;
