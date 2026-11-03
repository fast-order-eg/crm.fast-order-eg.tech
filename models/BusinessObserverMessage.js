import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const BusinessObserverMessage = sequelize.define('BusinessObserverMessage', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    messageId: {
        type: DataTypes.STRING(191),
        allowNull: false,
        comment: 'معرف رسالة الواتساب'
    },
    chatJid: {
        type: DataTypes.STRING(191),
        allowNull: false,
        comment: 'معرف المحادثة أو الجروب'
    },
    chatName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'اسم الجروب أو جهة الاتصال'
    },
    isGroup: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    senderPhone: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    senderJid: {
        type: DataTypes.STRING(191),
        allowNull: true
    },
    senderName: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    isFromMe: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'هل الرسالة مرسلة من الرقم المراقب أم واردة إليه'
    },
    messageType: {
        type: DataTypes.ENUM('text', 'audio', 'image', 'video', 'document', 'sticker', 'other'),
        defaultValue: 'text'
    },
    content: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: 'نص الرسالة أو الوصف المرفق'
    },
    transcription: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: 'تحويل التسجيل الصوتي إلى نص مقروء بالذكاء الاصطناعي'
    },
    mediaFileName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'اسم ملف الوسائط خصوصاً للفيديو والمستندات'
    },
    mediaMimeType: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    mediaSize: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'حجم الملف بالبايت'
    },
    mediaDuration: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'مدة الفويس أو الفيديو بالثواني'
    },
    mediaUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: 'مسار الملف المحفوظ محلياً للصوت والصور'
    },
    matchedEmployeeName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'اسم الموظف المطابق إن وجد'
    },
    matchedEmployeeRole: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'دور الموظف المطابق'
    },
    messageTimestamp: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: 'توقيت الرسالة في الواتساب'
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
    tableName: 'business_observer_messages',
    timestamps: true,
    indexes: [
        { fields: ['messageId'] },
        { fields: ['chatJid'] },
        { fields: ['senderPhone'] },
        { fields: ['messageTimestamp'] },
        { fields: ['matchedEmployeeName'] }
    ]
});

User.hasMany(BusinessObserverMessage, { foreignKey: 'UserId', as: 'observerMessages', onDelete: 'CASCADE' });
BusinessObserverMessage.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

export default BusinessObserverMessage;
