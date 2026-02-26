// server/routes/analytics.js
import express from 'express';
import { db } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';

const router = express.Router();

// Получение сводной аналитики для мастера
router.get('/summary', authenticateToken, requireMaster, (req, res) => {
    try {
        const masterId = req.user.id;
        
        const analytics = db.prepare(`
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
        `).get(masterId);
        
        const dailyStats = db.prepare(`
            SELECT DATE(o.created_at) as date, COUNT(*) as count
            FROM orders o
            WHERE o.masterId = ? AND o.created_at >= DATE('now', '-30 days')
            GROUP BY DATE(o.created_at)
            ORDER BY date DESC
        `).all(masterId);
        
        const categoryStats = db.prepare(`
            SELECT 
                c.id,
                c.name,
                COUNT(o.id) as ordersCount,
                SUM(s.price) as revenue
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            JOIN categories c ON s.categoryId = c.id
            WHERE o.masterId = ? AND o.status = 'DONE'
            GROUP BY c.id, c.name
            ORDER BY revenue DESC
        `).all(masterId);
        
        res.json({
            summary: {
                total: analytics.total || 0,
                completed: analytics.completed || 0,
                cancelled: analytics.cancelled || 0,
                pending: analytics.pending || 0,
                completionRate: analytics.total ? 
                    Math.round((analytics.completed / analytics.total) * 100) : 0,
                avgCompletionHours: analytics.avgCompletionHours ? 
                    Math.round(analytics.avgCompletionHours * 10) / 10 : 0,
                totalRevenue: analytics.totalRevenue || 0
            },
            daily: dailyStats.map(d => ({
                date: d.date,
                count: d.count
            })),
            byCategory: categoryStats
        });
    } catch (error) {
        console.error('Ошибка получения аналитики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение аналитики по месяцам
router.get('/monthly', authenticateToken, requireMaster, (req, res) => {
    try {
        const masterId = req.user.id;
        
        const monthlyStats = db.prepare(`
            SELECT 
                strftime('%Y-%m', o.created_at) as month,
                COUNT(*) as total,
                SUM(CASE WHEN o.status = 'DONE' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
                SUM(s.price) as revenue
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            WHERE o.masterId = ? AND o.created_at >= DATE('now', '-12 months')
            GROUP BY strftime('%Y-%m', o.created_at)
            ORDER BY month DESC
        `).all(masterId);
        
        res.json(monthlyStats);
    } catch (error) {
        console.error('Ошибка получения месячной аналитики:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;