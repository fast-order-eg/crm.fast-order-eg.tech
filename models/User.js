import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import bcrypt from 'bcrypt';

const User = sequelize.define('User', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    role: {
        type: DataTypes.ENUM('super_admin', 'admin', 'sales'),
        defaultValue: 'sales'
    },
    fullName: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'الاسم الكامل للموظف'
    },
    phone: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'رقم هاتف الموظف'
    },
    workStartTime: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: '09:00',
        comment: 'بداية وقت العمل'
    },
    workEndTime: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: '17:00',
        comment: 'نهاية وقت العمل'
    },
    workDays: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'السبت,الأحد,الإثنين,الثلاثاء,الأربعاء',
        comment: 'أيام العمل'
    },
    substituteUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        comment: 'الموظف البديل'
    },
    isOnLeave: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'هل الموظف في إجازة'
    },
    maxCustomers: {
        type: DataTypes.INTEGER,
        defaultValue: 50,
        comment: 'الحد الأقصى للعملاء المخصصين'
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    auto_reply: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    instructions_content: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: ''
    },
    pause_until: {
        type: DataTypes.DATE, // Full timestamp for pause timer
        allowNull: true
    },
    control_group_jid: {
        type: DataTypes.STRING, // Store JID of the control group
        allowNull: true
    },
    settings: {
        type: DataTypes.JSON,
        defaultValue: {}
    },
    linked_phone_number: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Stores the connected WhatsApp phone number'
    },
    connection_status: {
        type: DataTypes.STRING,
        defaultValue: 'offline', // online, offline, paused, not_registered
        allowNull: true
    },
    expiry_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: 'Date when the user subscription expires'
    },
    total_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'Total estimated tokens used by the user'
    },
    inactivity_summary: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'Send conversation summary to control group after 15 min inactivity'
    },
    bot_mode: {
        type: DataTypes.STRING,
        defaultValue: 'menu_only', // 'ai_only', 'hybrid', 'menu_only'
        comment: 'وضع عمل البوت'
    },
    buttons_disabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: 'تعطيل ردود البوت بالأزرار بالكامل'
    },
    notificationPhone: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'رقم واتساب الموظف لاستقبال الإشعارات والملخصات'
    },
    enableNotifications: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'تفعيل إرسال الإشعارات والملخصات على الواتساب'
    }
}, {
    tableName: 'users',
    hooks: {
        beforeCreate: async (user) => {
            if (user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        },
        beforeUpdate: async (user) => {
            if (user.changed('password')) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(user.password, salt);
            }
        }
    }
});

User.prototype.validPassword = async function (password) {
    return await bcrypt.compare(password, this.password);
};

User.belongsTo(User, { as: 'substituteUser', foreignKey: 'substituteUserId' });

export default User;
