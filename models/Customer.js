import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const Customer = sequelize.define('Customer', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    customerNumber: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'رقم تسلسلي للعميل خاص بكل مستخدم'
    },
    phoneNumber: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'رقم واتساب العميل'
    },
    customerName: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'اسم العميل (من واتساب pushName)'
    },
    email: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'البريد الإلكتروني'
    },
    remoteJid: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'WhatsApp JID للتواصل'
    },
    aiSummary: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'ملخص المحادثة بالذكاء الاصطناعي'
    },
    selectedReason: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'سبب تعلم اللغة (سفر/سياحة/كول سنتر/دراسة)'
    },
    firstContactAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'تاريخ بداية المحادثة'
    },
    lastReplyAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'تاريخ آخر رد من العميل'
    },
    lastBotMessageAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'تاريخ آخر رسالة من البوت'
    },
    assignedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'تاريخ تحويل العميل لموظف المبيعات'
    },
    scheduledFollowUpAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'تاريخ المتابعة المجدولة'
    },
    completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'تاريخ إتمام البيع'
    },
    status: {
        type: DataTypes.ENUM(
            'new',
            'in_funnel',
            'awaiting_payment',
            'awaiting_sales',
            'first_follow_up',
            'final_follow_up',
            'scheduled_follow_up',
            'successful',
            'not_interested'
        ),
        defaultValue: 'new'
    },
    paymentStatus: {
        type: DataTypes.ENUM('pending', 'receipt_uploaded', 'confirmed', 'rejected'),
        defaultValue: 'pending'
    },
    paymentReceiptUrl: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'رابط صورة إيصال الدفع'
    },
    paymentMethod: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'طريقة الدفع (instapay/vodafone_cash)'
    },
    paymentAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true
    },
    assignedToUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'موظف المبيعات المسؤول'
    },
    notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'ملاحظات موظف المبيعات'
    },
    currentFunnelStep: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'الخطوة الحالية في الفانل'
    },
    funnelData: {
        type: DataTypes.JSON,
        defaultValue: {},
        comment: 'بيانات إضافية عن رحلة العميل'
    },
    leadTemperature: {
        type: DataTypes.ENUM('hot', 'warm', 'cold'),
        defaultValue: 'warm'
    },
    source: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'مصدر العميل (واتساب/إعلان/إحالة)'
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
    tableName: 'customers',
    indexes: [
        {
            unique: true,
            fields: ['UserId', 'phoneNumber']
        }
    ]
});

// Relationships
User.hasMany(Customer, { foreignKey: 'UserId', as: 'customers', onDelete: 'CASCADE' });
Customer.belongsTo(User, { foreignKey: 'UserId', as: 'owner' });

User.hasMany(Customer, { foreignKey: 'assignedToUserId', as: 'assignedCustomers' });
Customer.belongsTo(User, { foreignKey: 'assignedToUserId', as: 'assignedTo' });

Customer.beforeCreate(async (customer, options) => {
    const maxNumber = await Customer.max('customerNumber', { where: { UserId: customer.UserId } });
    customer.customerNumber = (maxNumber || 0) + 1;
});

export default Customer;
