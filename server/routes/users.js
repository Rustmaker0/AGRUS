// server/routes/users.js
import express from 'express';
import { db, User } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Публичные маршруты (НЕ требуют авторизации)
router.get('/masters', (req, res) => {
    try {
        const { search, limit = 20 } = req.query;
        
        let sql = `
            SELECT 
                u.id,
                u.name,
                u.email,
                u.created_at,
                COUNT(DISTINCT s.id) as servicesCount,
                COUNT(DISTINCT CASE WHEN o.status = 'DONE' THEN o.id END) as completedOrders
            FROM users u
            LEFT JOIN services s ON u.id = s.masterId
            LEFT JOIN orders o ON s.id = o.serviceId
            WHERE u.role = 'master'
            GROUP BY u.id, u.name, u.email, u.created_at
            ORDER BY completedOrders DESC
        `;
        
        if (search) {
            sql = sql.replace('WHERE u.role = \'master\'', 
                `WHERE u.role = 'master' AND (u.name LIKE '%${search}%' OR u.email LIKE '%${search}%')`);
        }
        
        if (limit) {
            sql += ` LIMIT ${parseInt(limit)}`;
        }
        
        const masters = db.prepare(sql).all();
        res.json(masters);
    } catch (error) {
        console.error('Ошибка получения списка мастеров:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/masters/:id', (req, res) => {
    try {
        const masterId = parseInt(req.params.id);
        
        const master = db.prepare(`
            SELECT 
                u.id,
                u.name,
                u.email,
                u.created_at,
                COUNT(DISTINCT s.id) as servicesCount,
                COUNT(DISTINCT CASE WHEN o.status = 'DONE' THEN o.id END) as completedOrders
            FROM users u
            LEFT JOIN services s ON u.id = s.masterId
            LEFT JOIN orders o ON s.id = o.serviceId
            WHERE u.id = ? AND u.role = 'master'
            GROUP BY u.id, u.name, u.email, u.created_at
        `).get(masterId);
        
        if (!master) {
            return res.status(404).json({ error: 'Мастер не найден' });
        }
        
        res.json(master);
    } catch (error) {
        console.error('Ошибка получения информации о мастере:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Защищенные маршруты (ТРЕБУЮТ авторизацию)
router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = db.prepare(`
            SELECT 
                id, role, name, email, created_at,
                (SELECT COUNT(*) FROM services WHERE masterId = users.id) as servicesCount,
                (SELECT COUNT(*) FROM orders WHERE clientId = users.id) as ordersAsClient,
                (SELECT COUNT(*) FROM orders WHERE masterId = users.id) as ordersAsMaster
            FROM users 
            WHERE id = ?
        `).get(req.user.id);
        
        res.json(user);
    } catch (error) {
        console.error('Ошибка получения пользователя:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.put('/profile', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const { name, email } = req.body;
        
        if (!name || !email) {
            return res.status(400).json({ error: 'Имя и email обязательны' });
        }
        
        const existingUser = db.prepare(`
            SELECT id FROM users WHERE email = ? AND id != ?
        `).get(email, userId);
        
        if (existingUser) {
            return res.status(400).json({ error: 'Этот email уже используется' });
        }
        
        User.update.run(name.trim(), email.trim(), userId);
        
        const updatedUser = User.findById.get(userId);
        res.json(updatedUser);
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;