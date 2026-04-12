// server/routes/users.js
import express from 'express';
import { db, User } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============

// Санитизация пользователя
function sanitizeUser(user, includeEmail = true) {
    if (!user) return null;
    
    const sanitized = { ...user };
    
    // Строковые поля
    if (sanitized.name) {
        sanitized.name = escapeHtml(String(sanitized.name));
    }
    
    if (includeEmail && sanitized.email) {
        sanitized.email = escapeHtml(String(sanitized.email));
    }
    
    // Числовые поля
    const numberFields = ['id', 'servicesCount', 'completedOrders', 'ordersAsClient', 'ordersAsMaster'];
    
    for (const field of numberFields) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            sanitized[field] = Number(sanitized[field]) || 0;
        }
    }
    
    return sanitized;
}

// Валидация имени
function validateName(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed.length < 2) return null;
    if (trimmed.length > 100) return null;
    // Разрешаем буквы, пробелы, дефисы и точки
    const safeRegex = /^[а-яА-Яa-zA-Z\s\-.]{2,100}$/u;
    if (!safeRegex.test(trimmed)) return null;
    return escapeHtml(trimmed);
}

// Валидация email
function validateEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const trimmed = email.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(trimmed)) return null;
    if (trimmed.length > 255) return null;
    return trimmed;
}

// Публичные маршруты (НЕ требуют авторизации)
router.get('/masters', (req, res) => {
    try {
        const { search, limit = 20 } = req.query;
        
        // Валидация лимита
        let safeLimit = parseInt(limit);
        if (isNaN(safeLimit) || safeLimit < 1) safeLimit = 20;
        if (safeLimit > 100) safeLimit = 100;
        
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
        
        const params = [];
        
        if (search && typeof search === 'string') {
            const safeSearch = search.trim();
            if (safeSearch.length > 0 && safeSearch.length <= 50) {
                sql = sql.replace('WHERE u.role = \'master\'', 
                    'WHERE u.role = \'master\' AND (u.name LIKE ? OR u.email LIKE ?)');
                const searchTerm = `%${safeSearch}%`;
                params.push(searchTerm, searchTerm);
            }
        }
        
        sql += ` LIMIT ?`;
        params.push(safeLimit);
        
        const masters = db.prepare(sql).all(...params);
        
        // Для публичного списка не показываем email полностью (только для защиты)
        const safeMasters = masters.map(master => ({
            ...sanitizeUser(master, false),
            email: master.email ? master.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null
        }));
        
        res.json(safeMasters);
    } catch (error) {
        console.error('Ошибка получения списка мастеров:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/masters/:id', (req, res) => {
    try {
        const masterId = parseInt(req.params.id);
        
        if (isNaN(masterId) || masterId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
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
        
        // Маскируем email для публичного просмотра
        const safeMaster = sanitizeUser(master, false);
        safeMaster.email = master.email ? master.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null;
        
        res.json(safeMaster);
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
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const safeUser = sanitizeUser(user, true);
        res.json(safeUser);
    } catch (error) {
        console.error('Ошибка получения пользователя:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.put('/profile', authenticateToken, (req, res) => {
    try {
        const userId = req.user.id;
        const { name, email } = req.body;
        
        // Валидация имени
        const safeName = validateName(name);
        if (!safeName) {
            return res.status(400).json({ 
                error: 'Имя должно содержать от 2 до 100 символов и только буквы, пробелы, дефисы и точки' 
            });
        }
        
        // Валидация email
        const safeEmail = validateEmail(email);
        if (!safeEmail) {
            return res.status(400).json({ error: 'Неверный формат email' });
        }
        
        // Проверяем, не занят ли email другим пользователем
        const existingUser = db.prepare(`
            SELECT id FROM users WHERE email = ? AND id != ?
        `).get(safeEmail, userId);
        
        if (existingUser) {
            return res.status(400).json({ error: 'Этот email уже используется' });
        }
        
        // Обновляем профиль
        User.update.run(safeName, safeEmail, userId);
        
        const updatedUser = User.findById.get(userId);
        const safeUser = sanitizeUser(updatedUser, true);
        
        res.json(safeUser);
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Смена пароля (дополнительный маршрут для безопасности)
router.put('/change-password', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Текущий и новый пароль обязательны' });
        }
        
        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'Новый пароль должен содержать минимум 4 символа' });
        }
        
        if (newPassword.length > 128) {
            return res.status(400).json({ error: 'Новый пароль слишком длинный' });
        }
        
        // Получаем пользователя с паролем
        const user = User.findByIdWithPassword.get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Проверяем текущий пароль
        const crypto = await import('crypto');
        const hash = crypto.default
            .createHash('sha512')
            .update(currentPassword + user.passSalt)
            .digest('hex');
        
        if (hash !== user.passHash) {
            return res.status(401).json({ error: 'Неверный текущий пароль' });
        }
        
        // Создаем новый пароль
        const newSalt = crypto.default.randomBytes(16).toString('hex');
        const newHash = crypto.default
            .createHash('sha512')
            .update(newPassword + newSalt)
            .digest('hex');
        
        // Обновляем пароль
        User.updatePassword.run(newSalt, newHash, userId);
        
        res.json({ message: 'Пароль успешно изменен' });
    } catch (error) {
        console.error('Ошибка смены пароля:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;