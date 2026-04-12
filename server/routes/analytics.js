// server/routes/analytics.js
import express from 'express';
import { db } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// Вспомогательная функция для безопасного округления чисел
const safeRound = (value, decimals = 1) => {
    if (value === null || value === undefined || isNaN(value)) return 0;
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

// Вспомогательная функция для экранирования строк в объектах
const sanitizeAnalyticsData = (data) => {
    if (!data) return data;
    
    const sanitized = { ...data };
    
    // Экранируем строковые поля
    if (sanitized.name) sanitized.name = escapeHtml(String(sanitized.name));
    if (sanitized.category_name) sanitized.category_name = escapeHtml(String(sanitized.category_name));
    if (sanitized.date) sanitized.date = escapeHtml(String(sanitized.date));
    if (sanitized.month) sanitized.month = escapeHtml(String(sanitized.month));
    
    // Обрабатываем вложенные объекты
    if (sanitized.summary) {
        sanitized.summary = { ...sanitized.summary };
        if (sanitized.summary.category_name) {
            sanitized.summary.category_name = escapeHtml(String(sanitized.summary.category_name));
        }
    }
    
    return sanitized;
};

// Получение сводной аналитики для мастера
router.get('/summary', authenticateToken, requireMaster, (req, res) => {
    try {
        const masterId = req.user.id;
        
        // Валидация ID мастера
        if (!masterId || isNaN(parseInt(masterId))) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
        // Используем параметризованный запрос для защиты от SQL инъекций
        const analytics = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN o.status = 'DONE' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
                SUM(CASE WHEN o.status = 'NEW' THEN 1 ELSE 0 END) as pending,
                AVG(CASE WHEN o.status = 'DONE' 
                    THEN (julianday(o.status_date) - julianday(o.created_at)) * 24 
                    ELSE NULL END) as avgCompletionHours,
                COALESCE(SUM(s.price), 0) as totalRevenue
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            WHERE o.masterId = ?
        `).get(masterId);
        
        // Валидируем и санируем данные
        const safeAnalytics = {
            total: Math.max(0, parseInt(analytics.total) || 0),
            completed: Math.max(0, parseInt(analytics.completed) || 0),
            cancelled: Math.max(0, parseInt(analytics.cancelled) || 0),
            pending: Math.max(0, parseInt(analytics.pending) || 0),
            completionRate: analytics.total ? 
                Math.min(100, Math.max(0, Math.round((analytics.completed / analytics.total) * 100))) : 0,
            avgCompletionHours: safeRound(analytics.avgCompletionHours, 1),
            totalRevenue: safeRound(analytics.totalRevenue, 2)
        };
        
        // Получаем дневную статистику с ограничением по времени
        const dailyStats = db.prepare(`
            SELECT DATE(o.created_at) as date, COUNT(*) as count
            FROM orders o
            WHERE o.masterId = ? AND o.created_at >= DATE('now', '-30 days')
            GROUP BY DATE(o.created_at)
            ORDER BY date DESC
            LIMIT 31
        `).all(masterId);
        
        // Санируем дневную статистику
        const safeDailyStats = dailyStats.map(stat => ({
            date: escapeHtml(String(stat.date)),
            count: Math.max(0, parseInt(stat.count) || 0)
        }));
        
        // Получаем статистику по категориям
        const categoryStats = db.prepare(`
            SELECT 
                c.id,
                c.name,
                COUNT(o.id) as ordersCount,
                COALESCE(SUM(s.price), 0) as revenue
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            JOIN categories c ON s.categoryId = c.id
            WHERE o.masterId = ? AND o.status = 'DONE'
            GROUP BY c.id, c.name
            ORDER BY revenue DESC
            LIMIT 50
        `).all(masterId);
        
        // Санируем статистику по категориям
        const safeCategoryStats = categoryStats.map(stat => ({
            id: Math.max(0, parseInt(stat.id) || 0),
            name: escapeHtml(String(stat.name)),
            ordersCount: Math.max(0, parseInt(stat.ordersCount) || 0),
            revenue: safeRound(stat.revenue, 2)
        }));
        
        // Формируем безопасный ответ
        const response = {
            summary: safeAnalytics,
            daily: safeDailyStats,
            byCategory: safeCategoryStats,
            _timestamp: new Date().toISOString(),
            _secure: true
        };
        
        res.json(response);
        
    } catch (error) {
        console.error('Ошибка получения аналитики:', error);
        
        // Не раскрываем детали ошибки клиенту
        res.status(500).json({ 
            error: 'Не удалось получить аналитику',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Получение аналитики по месяцам
router.get('/monthly', authenticateToken, requireMaster, (req, res) => {
    try {
        const masterId = req.user.id;
        
        // Валидация ID мастера
        if (!masterId || isNaN(parseInt(masterId))) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
        // Валидация и санитизация параметров запроса
        const { limit } = req.query;
        const monthsLimit = Math.min(24, Math.max(1, parseInt(limit) || 12));
        
        // Параметризованный запрос с ограничением
        const monthlyStats = db.prepare(`
            SELECT 
                strftime('%Y-%m', o.created_at) as month,
                COUNT(*) as total,
                SUM(CASE WHEN o.status = 'DONE' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
                COALESCE(SUM(s.price), 0) as revenue
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            WHERE o.masterId = ? AND o.created_at >= DATE('now', ?)
            GROUP BY strftime('%Y-%m', o.created_at)
            ORDER BY month DESC
            LIMIT ?
        `).all(masterId, `-${monthsLimit} months`, monthsLimit);
        
        // Санируем данные перед отправкой
        const safeMonthlyStats = monthlyStats.map(stat => ({
            month: escapeHtml(String(stat.month)),
            total: Math.max(0, parseInt(stat.total) || 0),
            completed: Math.max(0, parseInt(stat.completed) || 0),
            cancelled: Math.max(0, parseInt(stat.cancelled) || 0),
            revenue: safeRound(stat.revenue, 2),
            completionRate: stat.total ? 
                Math.min(100, Math.max(0, Math.round((stat.completed / stat.total) * 100))) : 0
        }));
        
        // Добавляем метаданные о запросе
        const response = {
            data: safeMonthlyStats,
            meta: {
                period: `${monthsLimit} months`,
                totalMonths: safeMonthlyStats.length,
                generated: new Date().toISOString()
            }
        };
        
        res.json(response);
        
    } catch (error) {
        console.error('Ошибка получения месячной аналитики:', error);
        res.status(500).json({ 
            error: 'Не удалось получить месячную аналитику',
            message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Дополнительный эндпоинт для получения топ-услуг мастера
router.get('/top-services', authenticateToken, requireMaster, (req, res) => {
    try {
        const masterId = req.user.id;
        const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
        
        const topServices = db.prepare(`
            SELECT 
                s.id,
                s.name,
                COUNT(o.id) as ordersCount,
                COALESCE(SUM(s.price), 0) as revenue
            FROM services s
            LEFT JOIN orders o ON o.serviceId = s.id AND o.masterId = ? AND o.status = 'DONE'
            WHERE s.masterId = ?
            GROUP BY s.id, s.name
            ORDER BY revenue DESC, ordersCount DESC
            LIMIT ?
        `).all(masterId, masterId, limit);
        
        const safeTopServices = topServices.map(service => ({
            id: Math.max(0, parseInt(service.id) || 0),
            name: escapeHtml(String(service.name)),
            ordersCount: Math.max(0, parseInt(service.ordersCount) || 0),
            revenue: safeRound(service.revenue, 2)
        }));
        
        res.json({
            services: safeTopServices,
            limit: limit,
            total: safeTopServices.length
        });
        
    } catch (error) {
        console.error('Ошибка получения топ-услуг:', error);
        res.status(500).json({ error: 'Не удалось получить топ-услуги' });
    }
});

export default router;