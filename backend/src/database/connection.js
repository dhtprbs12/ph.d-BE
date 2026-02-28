const mysql = require('mysql2/promise');

let pool = null;

const connectDB = async () => {
  try {
    // Railway provides MYSQL_URL; local dev uses individual vars
    const dbUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;

    const poolConfig = dbUrl
      ? { uri: dbUrl, waitForConnections: true, connectionLimit: 10, queueLimit: 0, enableKeepAlive: true, keepAliveInitialDelay: 0 }
      : {
          host: process.env.DB_HOST,
          port: process.env.DB_PORT || 3306,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          enableKeepAlive: true,
          keepAliveInitialDelay: 0
        };

    pool = mysql.createPool(poolConfig);

    // Test connection
    const connection = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    connection.release();
    
    return pool;
  } catch (error) {
    console.error('❌ MySQL connection failed:', error.message);
    throw error;
  }
};

const getPool = () => {
  if (!pool) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return pool;
};

const query = async (sql, params) => {
  const pool = getPool();
  // Use query() instead of execute() for more flexible parameter handling
  const [results] = await pool.query(sql, params);
  return results;
};

module.exports = { connectDB, getPool, query };

