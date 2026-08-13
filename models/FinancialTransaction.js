import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';
import Customer from './Customer.js';

const FinancialTransaction = sequelize.define('FinancialTransaction', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    type: {
        type: DataTypes.ENUM('income', 'expense'),
        allowNull: false,
        comment: 'نوع العملية: إيرادات أو مصروفات'
    },
    amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: 'المبلغ'
    },
    currency: {
        type: DataTypes.STRING(10),
        defaultValue: 'EGP',
        comment: 'العملة'
    },
    category: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'الفئة (اشتراكات، رواتب، إعلانات، أخرى)'
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'الوصف التفصيلي'
    },
    reference: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'الرقم المرجعي (مثل رقم الفاتورة أو إيصال الدفع)'
    },
    CustomerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'customers',
            key: 'id'
        },
        comment: 'العميل المرتبط بالعملية إن وجد'
    },
    recordedByUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف الذي قام بتسجيل العملية'
    },
    transactionDate: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: 'تاريخ العملية المالي'
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'صاحب البوت / الأدمن الرئيسي للفصل بين حسابات المستخدمين'
    }
}, {
    tableName: 'financial_transactions',
    timestamps: true
});

// Relationships
User.hasMany(FinancialTransaction, { foreignKey: 'UserId', as: 'financialTransactions', onDelete: 'CASCADE' });
FinancialTransaction.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

User.hasMany(FinancialTransaction, { foreignKey: 'recordedByUserId', as: 'recordedTransactions' });
FinancialTransaction.belongsTo(User, { foreignKey: 'recordedByUserId', as: 'recorder' });

Customer.hasMany(FinancialTransaction, { foreignKey: 'CustomerId', as: 'financialTransactions', onDelete: 'SET NULL' });
FinancialTransaction.belongsTo(Customer, { foreignKey: 'CustomerId', as: 'customer' });

export default FinancialTransaction;
