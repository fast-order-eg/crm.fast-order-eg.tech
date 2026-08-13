import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

const dialect = process.env.DB_DIALECT || 'mysql';

let sequelize;

if (dialect === 'sqlite') {
    sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: process.env.DB_STORAGE || 'database.sqlite',
        logging: false,
    });
} else {
    sequelize = new Sequelize(
        process.env.DB_NAME,
        process.env.DB_USER,
        process.env.DB_PASS,
        {
            host: process.env.DB_HOST,
            dialect: 'mysql',
            logging: false,
        }
    );
}

export default sequelize;
