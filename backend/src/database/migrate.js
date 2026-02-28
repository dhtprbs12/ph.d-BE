require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const runMigration = async () => {
  let connection;
  const isProduction = process.env.NODE_ENV === 'production';
  const dbUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;
  
  try {
    if (dbUrl) {
      // Railway / production: connect via URL (database already exists)
      connection = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
      console.log('🔌 Connected to MySQL via URL');
    } else {
      // Local dev: connect without database to create it if needed
      connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        multipleStatements: true
      });
      console.log('🔌 Connected to MySQL server');

      if (isProduction) {
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME}`);
        console.log(`📦 Database '${process.env.DB_NAME}' ensured`);
      } else {
        await connection.query(`DROP DATABASE IF EXISTS ${process.env.DB_NAME}`);
        await connection.query(`CREATE DATABASE ${process.env.DB_NAME}`);
        console.log(`📦 Database '${process.env.DB_NAME}' created fresh`);
      }

      await connection.query(`USE ${process.env.DB_NAME}`);
    }

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    const cleanSchema = schema
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    console.log('📝 Executing schema (CREATE TABLE IF NOT EXISTS)...');
    await connection.query(cleanSchema);
    console.log('✅ Schema migration completed successfully');

    const [tables] = await connection.query('SHOW TABLES');
    console.log(`📊 ${tables.length} tables ready:`);
    tables.forEach(t => console.log(`   - ${Object.values(t)[0]}`));

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (error.sql) {
      console.error('Failed SQL:', error.sql.substring(0, 200));
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

runMigration();

