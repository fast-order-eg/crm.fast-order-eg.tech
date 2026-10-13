import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const CommissionService = sequelize.define('CommissionService', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'اسم الخدمة (مثل: إعلان ممول، متجر إلكتروني)'
    },
    rate: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: 'نسبة العمولة المئوية المستحقة على هذه الخدمة'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'حالة تفعيل الخدمة'
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'المالك الرئيسي للبيانات / الأدمن'
    }
}, {
    tableName: 'commission_services',
    timestamps: true
});

CommissionService.belongsTo(User, { as: 'owner', foreignKey: 'UserId' });

export default CommissionService;
