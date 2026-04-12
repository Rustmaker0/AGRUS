// server/routes/notifications.js
import express from 'express';
import { Notification } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// Вспомогательная функция для безопасного парсинга JSON
function safeParseJson(value) {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        // Рекурсивно экранируем все строки в объекте
        return sanitizeObject(parsed);
    } catch {
        return {};
    }
}

// Рекурсивная санитизация объекта
function sanitizeObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return escapeHtml(obj);
    if (typeof obj === 'number') return obj;
    if (typeof obj === 'boolean') return obj;
    if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item));
    if (typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            sanitized[key] = sanitizeObject(value);
        }
        return sanitized;
    }
    return obj;
}

// Вспомогательная функция для санитизации уведомления
function normalizeNotification(row) {
    if (!row) return null;
    
    return {
        id: row.id,
        recipientUserId: row.recipientUserId,
        orderId: row.orderId,
        type: escapeHtml(String(row.type || '')),
        channel: escapeHtml(String(row.channel || '')),
        title: escapeHtml(String(row.title || '')),
        message: escapeHtml(String(row.message || '')),
        meta: safeParseJson(row.meta),
        scheduledFor: row.scheduledFor,
        readAt: row.readAt,
        isRead: Boolean(row.readAt),
        created_at: row.created_at
    };
}

// Получение уведомлений пользователя
router.get('/', authenticateToken, (req, res) => {
    try {
        // Валидация параметров запроса
        let limit = parseInt(req.query.limit);
        if (isNaN(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;
        
        let offset = parseInt(req.query.offset);
        if (isNaN(offset) || offset < 0) offset = 0;
        
        const unreadOnly = String(req.query.unreadOnly || '') === '1';
        const now = Date.now();

        let notifications = Notification.listVisibleByUser.all(req.user.id, now, limit, offset)
            .map(normalizeNotification)
            .filter(n => n !== null);

        if (unreadOnly) {
            notifications = notifications.filter((item) => !item.isRead);
        }

        const unread = Notification.countVisibleUnreadByUser.get(req.user.id, now)?.count || 0;

        res.json({
            items: notifications,
            unread: unread,
            limit: limit,
            offset: offset,
            total: notifications.length
        });
    } catch (error) {
        console.error('Ошибка получения уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение количества непрочитанных уведомлений
router.get('/unread-count', authenticateToken, (req, res) => {
    try {
        const count = Notification.countVisibleUnreadByUser.get(req.user.id, Date.now())?.count || 0;
        res.json({ unread: count });
    } catch (error) {
        console.error('Ошибка получения количества непрочитанных уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Отметить все уведомления как прочитанные
router.patch('/read-all', authenticateToken, (req, res) => {
    try {
        const result = Notification.markAllReadByUser.run(req.user.id, Date.now());
        res.json({
            message: 'Все доступные уведомления помечены как прочитанные',
            updated: result.changes || 0
        });
    } catch (error) {
        console.error('Ошибка массового обновления уведомлений:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Отметить конкретное уведомление как прочитанное
router.patch('/:id/read', authenticateToken, (req, res) => {
    try {
        const notificationId = Number(req.params.id);
        
        // Валидация ID
        if (!Number.isInteger(notificationId) || notificationId <= 0) {
            return res.status(400).json({ error: 'Некорректный id уведомления' });
        }

        const item = Notification.getByIdForUser.get(notificationId, req.user.id);
        if (!item) {
            return res.status(404).json({ error: 'Уведомление не найдено' });
        }

        Notification.markRead.run(notificationId, req.user.id);
        const updated = Notification.getByIdForUser.get(notificationId, req.user.id);
        
        const normalized = normalizeNotification(updated);
        if (!normalized) {
            return res.status(500).json({ error: 'Ошибка при обработке уведомления' });
        }
        
        res.json(normalized);
    } catch (error) {
        console.error('Ошибка пометки уведомления как прочитанного:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление уведомления (опционально)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const notificationId = Number(req.params.id);
        
        if (!Number.isInteger(notificationId) || notificationId <= 0) {
            return res.status(400).json({ error: 'Некорректный id уведомления' });
        }
        
        // Проверяем, принадлежит ли уведомление пользователю
        const item = Notification.getByIdForUser.get(notificationId, req.user.id);
        if (!item) {
            return res.status(404).json({ error: 'Уведомление не найдено' });
        }
        
        // Удаляем уведомление (нужно добавить метод в database.js)
        if (Notification.delete) {
            Notification.delete.run(notificationId);
            res.json({ message: 'Уведомление удалено', id: notificationId });
        } else {
            res.status(501).json({ error: 'Удаление уведомлений пока не поддерживается' });
        }
    } catch (error) {
        console.error('Ошибка удаления уведомления:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;