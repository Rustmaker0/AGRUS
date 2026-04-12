// server/database.js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'agrus.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

autoMigrateAndInitialize();
setInterval(cleanupSessions, 6 * 60 * 60 * 1000);

function autoMigrateAndInitialize() {
    console.log('Проверка структуры базы данных...');
    createTables();
    createIndexes();
    console.log('База данных готова!');
}

function createTables() {
    db.exec(`
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
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

    db.exec(`
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            userId INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.exec(`
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipientUserId INTEGER NOT NULL,
            orderId INTEGER,
            type TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT 'in_app',
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            meta TEXT,
            scheduledFor INTEGER,
            readAt DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (recipientUserId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);
}

function createIndexes() {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_token_expires ON sessions(token, expiresAt);
        CREATE INDEX IF NOT EXISTS idx_orders_master_datetime ON orders(masterId, desired_datetime);
        CREATE INDEX IF NOT EXISTS idx_orders_client_datetime ON orders(clientId, desired_datetime);
        CREATE INDEX IF NOT EXISTS idx_notifications_recipient_scheduled ON notifications(recipientUserId, scheduledFor, readAt);
        CREATE INDEX IF NOT EXISTS idx_notifications_order_type ON notifications(orderId, type);
    `);
}

// Добавляем недостающий метод для смены пароля
export const User = {
    findByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    findById: db.prepare('SELECT id, role, name, email, created_at FROM users WHERE id = ?'),
    findByIdWithPassword: db.prepare('SELECT * FROM users WHERE id = ?'),
    create: db.prepare(`
        INSERT INTO users (role, name, email, passSalt, passHash)
        VALUES (?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
        UPDATE users SET name = ?, email = ? WHERE id = ?
    `),
    updatePassword: db.prepare(`
        UPDATE users SET passSalt = ?, passHash = ? WHERE id = ?
    `),
    delete: db.prepare('DELETE FROM users WHERE id = ?')
};

export const Session = {
    create: db.prepare(`
        INSERT INTO sessions (token, userId, expiresAt)
        VALUES (?, ?, ?)
    `),
    findByToken: db.prepare(`
        SELECT s.*, u.role, u.name, u.email
        FROM sessions s
        JOIN users u ON s.userId = u.id
        WHERE s.token = ? AND s.expiresAt > ?
    `),
    deleteByToken: db.prepare('DELETE FROM sessions WHERE token = ?'),
    deleteByUserId: db.prepare('DELETE FROM sessions WHERE userId = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expiresAt < ?')
};

export const Category = {
    getAll: db.prepare('SELECT * FROM categories ORDER BY name'),
    getById: db.prepare('SELECT * FROM categories WHERE id = ?'),
    create: db.prepare('INSERT INTO categories (name) VALUES (?)'),
    update: db.prepare('UPDATE categories SET name = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM categories WHERE id = ?'),
    checkServices: db.prepare('SELECT COUNT(*) as count FROM services WHERE categoryId = ?')
};

export const Service = {
    getAll: db.prepare(`
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

    getById: db.prepare(`
        SELECT
            s.*,
            c.name as categoryName,
            u.name as masterName
        FROM services s
        JOIN categories c ON s.categoryId = c.id
        JOIN users u ON s.masterId = u.id
        WHERE s.id = ?
    `),

    getByMaster: db.prepare(`
        SELECT s.*, c.name as categoryName
        FROM services s
        JOIN categories c ON s.categoryId = c.id
        WHERE s.masterId = ?
        ORDER BY s.created_at DESC
    `),

    getByCategory: db.prepare(`
        SELECT s.*, u.name as masterName
        FROM services s
        JOIN users u ON s.masterId = u.id
        WHERE s.categoryId = ?
        ORDER BY s.created_at DESC
    `),

    create: db.prepare(`
        INSERT INTO services (masterId, categoryId, title, description, price)
        VALUES (?, ?, ?, ?, ?)
    `),

    update: db.prepare(`
        UPDATE services
        SET categoryId = ?, title = ?, description = ?, price = ?
        WHERE id = ? AND masterId = ?
    `),

    delete: db.prepare('DELETE FROM services WHERE id = ? AND masterId = ?'),
    checkOrders: db.prepare('SELECT COUNT(*) as count FROM orders WHERE serviceId = ?')
};

export const Order = {
    getById: db.prepare(`
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
    `),

    getByClient: db.prepare(`
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
    `),

    getByMaster: db.prepare(`
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
    `),

    getByStatus: db.prepare(`
        SELECT
            o.*,
            s.title as serviceTitle,
            u.name as clientName
        FROM orders o
        JOIN services s ON o.serviceId = s.id
        JOIN users u ON o.clientId = u.id
        WHERE o.masterId = ? AND o.status = ?
        ORDER BY o.desired_datetime ASC
    `),

    create: db.prepare(`
        INSERT INTO orders (serviceId, masterId, clientId, comment, desired_datetime)
        VALUES (?, ?, ?, ?, ?)
    `),

    updateStatus: db.prepare(`
        UPDATE orders
        SET status = ?, status_date = CURRENT_TIMESTAMP, rejectionReason = ?
        WHERE id = ?
    `),

    reschedule: db.prepare(`
        UPDATE orders
        SET desired_datetime = ?, comment = ?, status_date = CURRENT_TIMESTAMP
        WHERE id = ?
    `),

    getAnalytics: db.prepare(`
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
    `),

    getDailyStats: db.prepare(`
        SELECT DATE(o.created_at) as date, COUNT(*) as count
        FROM orders o
        WHERE o.masterId = ? AND o.created_at >= DATE('now', '-30 days')
        GROUP BY DATE(o.created_at)
        ORDER BY date DESC
    `)
};

export const Availability = {
    getByMaster: db.prepare('SELECT * FROM availability WHERE masterId = ?'),
    upsert: db.prepare(`
        INSERT INTO availability (masterId, slotMinutes, weekTemplate, exceptions, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(masterId) DO UPDATE SET
            slotMinutes = excluded.slotMinutes,
            weekTemplate = excluded.weekTemplate,
            exceptions = excluded.exceptions,
            updated_at = CURRENT_TIMESTAMP
    `),
    delete: db.prepare('DELETE FROM availability WHERE masterId = ?')
};

export const Notification = {
    create: db.prepare(`
        INSERT INTO notifications (
            recipientUserId,
            orderId,
            type,
            channel,
            title,
            message,
            meta,
            scheduledFor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    listVisibleByUser: db.prepare(`
        SELECT
            id,
            recipientUserId,
            orderId,
            type,
            channel,
            title,
            message,
            meta,
            scheduledFor,
            readAt,
            created_at
        FROM notifications
        WHERE recipientUserId = ?
          AND (scheduledFor IS NULL OR scheduledFor <= ?)
        ORDER BY COALESCE(scheduledFor, CAST(strftime('%s', created_at) AS INTEGER) * 1000) DESC, id DESC
        LIMIT ? OFFSET ?
    `),

    countVisibleUnreadByUser: db.prepare(`
        SELECT COUNT(*) as count
        FROM notifications
        WHERE recipientUserId = ?
          AND readAt IS NULL
          AND (scheduledFor IS NULL OR scheduledFor <= ?)
    `),

    markRead: db.prepare(`
        UPDATE notifications
        SET readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
        WHERE id = ? AND recipientUserId = ?
    `),

    markAllReadByUser: db.prepare(`
        UPDATE notifications
        SET readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
        WHERE recipientUserId = ?
          AND readAt IS NULL
          AND (scheduledFor IS NULL OR scheduledFor <= ?)
    `),

    getByIdForUser: db.prepare(`
        SELECT *
        FROM notifications
        WHERE id = ? AND recipientUserId = ?
    `),

    deletePendingRemindersByOrder: db.prepare(`
        DELETE FROM notifications
        WHERE orderId = ?
          AND type = 'ORDER_REMINDER'
          AND readAt IS NULL
          AND scheduledFor IS NOT NULL
    `),

    delete: db.prepare(`
        DELETE FROM notifications WHERE id = ?
    `),

    deleteExpiredRead: db.prepare(`
        DELETE FROM notifications
        WHERE readAt IS NOT NULL
          AND created_at < datetime('now', '-90 days')
    `)
};

export function cleanupSessions() {
    const now = Date.now();
    Session.deleteExpired.run(now);
    Notification.deleteExpiredRead.run();
    console.log('Очистка старых сессий и прочитанных уведомлений выполнена');
}

export { db };