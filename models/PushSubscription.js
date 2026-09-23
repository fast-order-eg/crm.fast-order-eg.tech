import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const PushSubscription = sequelize.define('PushSubscription', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'المستخدم / الموظف صاحب الجهاز'
    },
    endpoint: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'رابط خادم الإشعارات الخاص بالمتصفح'
    },
    endpointHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        comment: 'MD5 hash of endpoint to prevent duplicates safely'
    },
    p256dh: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'مفتاح التشفير العام للجهاز'
    },
    auth: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: 'مفتاح المصادقة السري'
    },
    deviceType: {
        type: DataTypes.STRING(30),
        defaultValue: 'unknown',
        comment: 'mobile, desktop, tablet, unknown'
    },
    browser: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Chrome, Edge, Safari, Firefox, etc.'
    },
    os: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: 'Android, Windows, iOS, macOS, Linux'
    },
    userAgent: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'بيانات المتصفح والنظام الكاملة'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'هل الاشتراك نشط ومفعل'
    },
    lastActiveAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'آخر وقت تم فيه تجديد الاشتراك'
    },
    lastNotifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'آخر وقت تم فيه إرسال إشعار بنجاح'
    }
}, {
    tableName: 'push_subscriptions',
    timestamps: true
});

// Relationships
User.hasMany(PushSubscription, { foreignKey: 'UserId', as: 'pushSubscriptions', onDelete: 'CASCADE' });
PushSubscription.belongsTo(User, { foreignKey: 'UserId', as: 'user' });

export default PushSubscription;
