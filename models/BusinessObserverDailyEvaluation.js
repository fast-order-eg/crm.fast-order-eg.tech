import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const BusinessObserverDailyEvaluation = sequelize.define('BusinessObserverDailyEvaluation', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    employeeId: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    employeeName: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    evaluationDate: {
        type: DataTypes.DATEONLY,
        allowNull: false
    },
    shift: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    ratingScore: {
        type: DataTypes.DECIMAL(3, 1),
        defaultValue: 8.0
    },
    ratingLabel: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    totalMessages: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    groupsActive: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    pros: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    cons: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    evidence: {
        type: DataTypes.TEXT,
        allowNull: true
    }
}, {
    tableName: 'business_observer_daily_evaluations',
    timestamps: true
});

BusinessObserverDailyEvaluation.belongsTo(User, { foreignKey: 'UserId', onDelete: 'CASCADE' });

export default BusinessObserverDailyEvaluation;
