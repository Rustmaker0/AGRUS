// server/database.js
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Создаем подключение к базе данных
const dbPath = path.join(__dirname, 'agrus.db');
const db = new sqlite3.Database(dbPath);

// Оборачиваем db в Promise для удобства (асинхронный API)
export const dbAsync = {
  // Для одиночных запросов
  get: (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  }),

  // Для множественных запросов
  all: (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  }),

  // Для INSERT/UPDATE/DELETE
  run: (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  }),

  // Для множественных запросов (создание таблиц)
  exec: (sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  })
};

// Включаем поддержку внешних ключей
await dbAsync.exec('PRAGMA foreign_keys = ON');

// Функция для инициализации базы данных
async function initializeDatabase() {
    console.log('Проверка структуры базы данных...');
    
    // Создаем таблицы, если их нет
    await createTables();
    
    console.log('База данных готова!');
}

// Создание таблиц
async function createTables() {
    // Таблица пользователей
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK(role IN ('client', 'master')),
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            passSalt TEXT NOT NULL,
            passHash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Таблица категорий
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Таблица услуг
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            masterId INTEGER NOT NULL,
            categoryId INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            price INTEGER NOT NULL CHECK(price > 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (masterId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
        )
    `);
    
    // Таблица заказов
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serviceId INTEGER NOT NULL,
            masterId INTEGER NOT NULL,
            clientId INTEGER NOT NULL,
            comment TEXT,
            desired_datetime DATETIME NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('NEW', 'ACCEPTED', 'REJECTED', 'DONE', 'CANCELLED')) DEFAULT 'NEW',
            status_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            rejectionReason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (serviceId) REFERENCES services(id) ON DELETE CASCADE,
            FOREIGN KEY (masterId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (clientId) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    
    // Таблица сессий
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            userId INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
    
    // Таблица доступности мастеров
    await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS availability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            masterId INTEGER UNIQUE NOT NULL,
            slotMinutes INTEGER DEFAULT 30,
            weekTemplate TEXT NOT NULL,
            exceptions TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (masterId) REFERENCES users(id) ON DELETE CASCADE
        )
    `);
}

// Функции для работы с пользователями
export const User = {
    findByEmail: async (email) => dbAsync.get('SELECT * FROM users WHERE email = ?', [email]),
    findById: async (id) => dbAsync.get('SELECT id, role, name, email, created_at FROM users WHERE id = ?', [id]),
    create: async (role, name, email, passSalt, passHash) => 
        dbAsync.run('INSERT INTO users (role, name, email, passSalt, passHash) VALUES (?, ?, ?, ?, ?)', 
                    [role, name, email, passSalt, passHash]),
    update: async (name, email, id) => 
        dbAsync.run('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, id]),
    delete: async (id) => dbAsync.run('DELETE FROM users WHERE id = ?', [id])
};

// Функции для работы с сессиями
export const Session = {
    create: async (token, userId, expiresAt) => 
        dbAsync.run('INSERT INTO sessions (token, userId, expiresAt) VALUES (?, ?, ?)', [token, userId, expiresAt]),
    
    findByToken: async (token, now) => dbAsync.get(`
        SELECT s.*, u.role, u.name, u.email 
        FROM sessions s
        JOIN users u ON s.userId = u.id
        WHERE s.token = ? AND s.expiresAt > ?
    `, [token, now]),
    
    deleteByToken: async (token) => dbAsync.run('DELETE FROM sessions WHERE token = ?', [token]),
    
    deleteExpired: async (now) => dbAsync.run('DELETE FROM sessions WHERE expiresAt < ?', [now])
};

// Функции для работы с категориями
export const Category = {
    getAll: async () => dbAsync.all('SELECT * FROM categories ORDER BY name'),
    getById: async (id) => dbAsync.get('SELECT * FROM categories WHERE id = ?', [id]),
    create: async (name) => dbAsync.run('INSERT INTO categories (name) VALUES (?)', [name]),
    update: async (name, id) => dbAsync.run('UPDATE categories SET name = ? WHERE id = ?', [name, id]),
    delete: async (id) => dbAsync.run('DELETE FROM categories WHERE id = ?', [id]),
    checkServices: async (id) => dbAsync.get('SELECT COUNT(*) as count FROM services WHERE categoryId = ?', [id])
};

// Функции для работы с услугами
export const Service = {
    getAll: async () => dbAsync.all(`
        SELECT 
            s.id,
            s.masterId,
            s.categoryId,
            s.title,
            s.description,
            s.price,
            s.created_at as service_created_at,
            c.name as categoryName,
            u.name as masterName 
        FROM services s
        JOIN categories c ON s.categoryId = c.id
        JOIN users u ON s.masterId = u.id
        ORDER BY s.created_at DESC
    `),
    
    getById: async (id) => dbAsync.get(`
        SELECT 
            s.*,
            c.name as categoryName,
            u.name as masterName 
        FROM services s
        JOIN categories c ON s.categoryId = c.id
        JOIN users u ON s.masterId = u.id
        WHERE s.id = ?
    `, [id]),
    
    getByMaster: async (masterId) => dbAsync.all(`
        SELECT s.*, c.name as categoryName 
        FROM services s
        JOIN categories c ON s.categoryId = c.id
        WHERE s.masterId = ?
        ORDER BY s.created_at DESC
    `, [masterId]),
    
    getByCategory: async (categoryId) => dbAsync.all(`
        SELECT s.*, u.name as masterName 
        FROM services s
        JOIN users u ON s.masterId = u.id
        WHERE s.categoryId = ?
        ORDER BY s.created_at DESC
    `, [categoryId]),
    
    create: async (masterId, categoryId, title, description, price) => 
        dbAsync.run('INSERT INTO services (masterId, categoryId, title, description, price) VALUES (?, ?, ?, ?, ?)',
                    [masterId, categoryId, title, description, price]),
    
    update: async (categoryId, title, description, price, id, masterId) => 
        dbAsync.run('UPDATE services SET categoryId = ?, title = ?, description = ?, price = ? WHERE id = ? AND masterId = ?',
                    [categoryId, title, description, price, id, masterId]),
    
    delete: async (id, masterId) => dbAsync.run('DELETE FROM services WHERE id = ? AND masterId = ?', [id, masterId]),
    
    checkOrders: async (id) => dbAsync.get('SELECT COUNT(*) as count FROM orders WHERE serviceId = ?', [id])
};

// Функции для работы с заказами
export const Order = {
    getById: async (id) => dbAsync.get(`
        SELECT 
            o.id,
            o.serviceId,
            o.masterId,
            o.clientId,
            o.comment,
            o.desired_datetime,
            o.status,
            o.status_date,
            o.rejectionReason,
            o.created_at as order_created_at,
            s.title as serviceTitle,
            s.price as servicePrice,
            s.created_at as service_created_at,
            c.name as categoryName,
            m.name as masterName,
            m.email as masterEmail,
            cl.name as clientName,
            cl.email as clientEmail
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        JOIN categories c ON s.categoryId = c.id
        JOIN users m ON o.masterId = m.id
        JOIN users cl ON o.clientId = cl.id
        WHERE o.id = ?
    `, [id]),
    
    getByClient: async (clientId) => dbAsync.all(`
        SELECT 
            o.*,
            s.title as serviceTitle,
            s.price as servicePrice,
            c.name as categoryName,
            u.name as masterName
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        JOIN categories c ON s.categoryId = c.id
        JOIN users u ON o.masterId = u.id
        WHERE o.clientId = ?
        ORDER BY o.created_at DESC
    `, [clientId]),
    
    getByMaster: async (masterId) => dbAsync.all(`
        SELECT 
            o.*,
            s.title as serviceTitle,
            s.price as servicePrice,
            c.name as categoryName,
            u.name as clientName
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        JOIN categories c ON s.categoryId = c.id
        JOIN users u ON o.clientId = u.id
        WHERE o.masterId = ?
        ORDER BY o.created_at DESC
    `, [masterId]),
    
    getByStatus: async (masterId, status) => dbAsync.all(`
        SELECT 
            o.*,
            s.title as serviceTitle,
            u.name as clientName
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        JOIN users u ON o.clientId = u.id
        WHERE o.masterId = ? AND o.status = ?
        ORDER BY o.desired_datetime ASC
    `, [masterId, status]),
    
    create: async (serviceId, masterId, clientId, comment, desired_datetime) => 
        dbAsync.run('INSERT INTO orders (serviceId, masterId, clientId, comment, desired_datetime) VALUES (?, ?, ?, ?, ?)',
                    [serviceId, masterId, clientId, comment, desired_datetime]),
    
    updateStatus: async (status, reason, id) => 
        dbAsync.run('UPDATE orders SET status = ?, status_date = CURRENT_TIMESTAMP, rejectionReason = ? WHERE id = ?',
                    [status, reason, id]),
    
    getAnalytics: async (masterId) => dbAsync.get(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN o.status = 'DONE' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN o.status = 'NEW' THEN 1 ELSE 0 END) as pending,
            AVG(CASE WHEN o.status = 'DONE' 
                THEN (julianday(o.status_date) - julianday(o.created_at)) * 24 
                ELSE NULL END) as avgCompletionHours,
            SUM(s.price) as totalRevenue
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        WHERE o.masterId = ?
    `, [masterId]),
    
    getDailyStats: async (masterId) => dbAsync.all(`
        SELECT DATE(o.created_at) as date, COUNT(*) as count
        FROM orders o
        WHERE o.masterId = ? AND o.created_at >= DATE('now', '-30 days')
        GROUP BY DATE(o.created_at)
        ORDER BY date DESC
    `, [masterId])
};

// Функции для работы с доступностью
export const Availability = {
    getByMaster: async (masterId) => dbAsync.get('SELECT * FROM availability WHERE masterId = ?', [masterId]),
    
    upsert: async (masterId, slotMinutes, weekTemplate, exceptions) => 
        dbAsync.run(`
            INSERT INTO availability (masterId, slotMinutes, weekTemplate, exceptions, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(masterId) DO UPDATE SET
                slotMinutes = excluded.slotMinutes,
                weekTemplate = excluded.weekTemplate,
                exceptions = excluded.exceptions,
                updated_at = CURRENT_TIMESTAMP
        `, [masterId, slotMinutes, weekTemplate, exceptions]),
    
    delete: async (masterId) => dbAsync.run('DELETE FROM availability WHERE masterId = ?', [masterId])
};

// Функция для очистки старых сессий
export async function cleanupSessions() {
    const now = Date.now();
    await Session.deleteExpired(now);
    console.log('Очистка старых сессий выполнена');
}

// Запускаем инициализацию
await initializeDatabase();

// Запускаем очистку сессий каждые 6 часов
setInterval(cleanupSessions, 6 * 60 * 60 * 1000);

// Экспортируем сам db для прямого доступа
export { dbAsync as db };