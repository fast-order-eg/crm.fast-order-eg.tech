import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const BaileysSession = sequelize.define('BaileysSession', {
    id: {
        type: DataTypes.STRING(255),
        primaryKey: true
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    data: {
        type: DataTypes.TEXT('long'),
        allowNull: false
    }
}, {
    tableName: 'baileys_sessions',
    timestamps: true,
    indexes: [
        {
            fields: ['userId']
        }
    ]
});

export default BaileysSession;
