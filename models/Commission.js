import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';
import CommissionService from './CommissionService.js';

const Commission = sequelize.define('Commission', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    serviceName: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'اسم الخدمة'
    },
    customerName: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'اسم العميل'
    },
    totalPaid: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'إجمالي المبلغ المدفوع من العميل'
    },
    serviceCost: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'تكلفة الخدمة'
    },
    netProfit: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'صافي الربح = إجمالي المدفوع - تكلفة الخدمة'
    },
    commissionRate: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'نسبة العمولة المطبقة (%)'
    },
    commissionAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'مبلغ العمولة المحسوب'
    },
    date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: 'تاريخ المعاملة'
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'ملاحظات إضافية'
    },
    isCustomRate: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'هل تم تحديد نسبة مخصصة بواسطة الأدمن'
    },
    commissionSystem: {
        type: DataTypes.STRING(20),
        defaultValue: 'system1',
        comment: 'نظام العمولة: system1 (صافي الربح) أو system2 (نسبة من الإجمالي حسب الخدمة)'
    },
    serviceId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'commission_services',
            key: 'id'
        },
        comment: 'الخدمة المرتبطة في حالة نظام 2'
    },
    employeeId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف المستحق للعمولة'
    },
    createdById: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف أو الأدمن الذي قام بتسجيل المعاملة'
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'صاحب الشركة / المالك الرئيسي'
    }
}, {
    tableName: 'commissions',
    timestamps: true
});

// Relationships
Commission.belongsTo(User, { as: 'employee', foreignKey: 'employeeId' });
Commission.belongsTo(User, { as: 'creator', foreignKey: 'createdById' });
Commission.belongsTo(User, { as: 'owner', foreignKey: 'UserId' });
Commission.belongsTo(CommissionService, { as: 'service', foreignKey: 'serviceId' });

User.hasMany(Commission, { as: 'commissions', foreignKey: 'employeeId' });
CommissionService.hasMany(Commission, { as: 'commissions', foreignKey: 'serviceId' });

export default Commission;
