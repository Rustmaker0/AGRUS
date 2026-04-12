// server/routes/orders.js
import express from 'express';
import { db, Order, Service, Availability } from '../database.js';
import { authenticateToken, requireClient } from '../middleware/auth.js';
import escapeHtml from 'escape-html';
import {
    createOrderCreatedNotifications,
    createOrderRescheduledNotifications,
    createOrderStatusNotifications,
    syncOrderReminderNotifications,
    removeOrderReminderNotifications
} from '../notification-service.js';

const router = express.Router();
const VALID_STATUSES = ['NEW', 'ACCEPTED', 'REJECTED', 'DONE', 'CANCELLED'];

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============

function parsePseudoUtcParts(value) {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/);
    if (!match) return null;

    return {
        year: Number(match[1]),
        monthIndex: Number(match[2]) - 1,
        day: Number(match[3]),
        hours: Number(match[4] || 0),
        minutes: Number(match[5] || 0),
        seconds: Number(match[6] || 0),
        milliseconds: Number(String(match[7] || '0').padEnd(3, '0'))
    };
}

function getPseudoUtcComparableTimestamp(value) {
    const parts = parsePseudoUtcParts(value);
    if (!parts) return Number.NaN;

    return Date.UTC(
        parts.year,
        parts.monthIndex,
        parts.day,
        parts.hours,
        parts.minutes,
        parts.seconds,
        parts.milliseconds
    );
}

function getCurrentComparableTimestamp() {
    const now = new Date();
    return Date.UTC(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
        now.getMilliseconds()
    );
}

// Вспомогательная функция для санитизации заказа
function sanitizeOrder(order) {
    if (!order) return null;
    
    const sanitized = { ...order };
    
    // Строковые поля для экранирования
    const stringFields = [
        'title', 'serviceTitle', 'serviceDescription', 'categoryName',
        'masterName', 'masterEmail', 'clientName', 'clientEmail',
        'comment', 'reason', 'status', 'desired_datetime', 'created_at',
        'status_date'
    ];
    
    for (const field of stringFields) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            if (typeof sanitized[field] === 'string') {
                sanitized[field] = escapeHtml(sanitized[field]);
            }
        }
    }
    
    // Числовые поля
    const numberFields = ['id', 'serviceId', 'masterId', 'clientId', 'categoryId', 'servicePrice', 'price'];
    
    for (const field of numberFields) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            sanitized[field] = Number(sanitized[field]) || 0;
        }
    }
    
    return sanitized;
}

// Валидация комментария
function validateComment(comment) {
    if (!comment) return null;
    if (typeof comment !== 'string') return null;
    if (comment.length > 1000) return null;
    return escapeHtml(comment.trim());
}

// Валидация причины отклонения
function validateReason(reason) {
    if (!reason) return null;
    if (typeof reason !== 'string') return null;
    if (reason.length > 500) return null;
    return escapeHtml(reason.trim());
}

function assertSlotFree(masterId, desiredISO, options = {}) {
    const availability = Availability.getByMaster.get(masterId);
    if (!availability) {
        throw Object.assign(new Error('Расписание мастера не задано'), { status: 400 });
    }

    const slotMinutes = availability.slotMinutes || 30;
    let weekTemplate, exceptions;
    
    try {
        weekTemplate = JSON.parse(availability.weekTemplate);
        exceptions = JSON.parse(availability.exceptions || '{}');
    } catch (parseError) {
        console.error('Ошибка парсинга расписания:', parseError);
        throw Object.assign(new Error('Ошибка в настройках расписания'), { status: 500 });
    }

    const parts = parsePseudoUtcParts(desiredISO);
    if (!parts) {
        throw Object.assign(new Error('Некорректная дата/время'), { status: 400, code: 'INVALID_DATETIME' });
    }

    const dateStr = `${parts.year}-${String(parts.monthIndex + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const currentMinutes = parts.hours * 60 + parts.minutes;
    const dayOfWeek = new Date(Date.UTC(parts.year, parts.monthIndex, parts.day)).getUTCDay();

    if (exceptions[dateStr] && exceptions[dateStr].length === 0) {
        throw Object.assign(new Error('Мастер не работает в этот день'), { status: 400, code: 'SLOT_NOT_IN_SCHEDULE' });
    }

    const intervals = exceptions[dateStr] || weekTemplate[dayOfWeek] || [];
    if (!intervals.length) {
        throw Object.assign(new Error('Мастер не работает в этот день'), { status: 400, code: 'SLOT_NOT_IN_SCHEDULE' });
    }

    let slotFitsSchedule = false;

    for (const [start, end] of intervals) {
        const [startHour, startMin] = start.split(':').map(Number);
        const [endHour, endMin] = end.split(':').map(Number);

        const startTotal = startHour * 60 + startMin;
        let endTotal = endHour * 60 + endMin;

        if (endTotal < startTotal) {
            endTotal += 24 * 60;
        }

        if (currentMinutes >= startTotal && currentMinutes + slotMinutes <= endTotal) {
            slotFitsSchedule = true;
            break;
        }
    }

    if (!slotFitsSchedule) {
        throw Object.assign(new Error('Выбранное время вне рабочего графика'), { status: 400, code: 'SLOT_NOT_IN_SCHEDULE' });
    }

    const slotStart = getPseudoUtcComparableTimestamp(desiredISO);
    const slotEnd = slotStart + slotMinutes * 60 * 1000;

    const busyOrdersQuery = options.excludeOrderId
        ? db.prepare(`
            SELECT id, desired_datetime
            FROM orders
            WHERE masterId = ?
              AND status IN ('NEW', 'ACCEPTED')
              AND date(desired_datetime) = date(?)
              AND id != ?
        `)
        : db.prepare(`
            SELECT id, desired_datetime
            FROM orders
            WHERE masterId = ?
              AND status IN ('NEW', 'ACCEPTED')
              AND date(desired_datetime) = date(?)
        `);

    const busyOrders = options.excludeOrderId
        ? busyOrdersQuery.all(masterId, desiredISO, options.excludeOrderId)
        : busyOrdersQuery.all(masterId, desiredISO);

    for (const order of busyOrders) {
        const existingStart = getPseudoUtcComparableTimestamp(order.desired_datetime);
        const existingEnd = existingStart + slotMinutes * 60 * 1000;

        if (Math.max(slotStart, existingStart) < Math.min(slotEnd, existingEnd)) {
            throw Object.assign(new Error('Этот слот уже занят'), { status: 409, code: 'SLOT_UNAVAILABLE' });
        }
    }

    return true;
}

// ============ МАРШРУТЫ ============

// Получение всех заказов
router.get('/', authenticateToken, (req, res) => {
    try {
        const user = req.user;
        let orders = [];

        if (user.role === 'client') {
            orders = db.prepare(`
                SELECT
                    o.*,
                    s.title as serviceTitle,
                    s.price as servicePrice,
                    c.name as categoryName,
                    u.name as masterName,
                    u.email as masterEmail
                FROM orders o
                JOIN services s ON o.serviceId = s.id
                JOIN categories c ON s.categoryId = c.id
                JOIN users u ON o.masterId = u.id
                WHERE o.clientId = ?
                ORDER BY o.created_at DESC
            `).all(user.id);
        } else if (user.role === 'master') {
            orders = db.prepare(`
                SELECT
                    o.*,
                    s.title as serviceTitle,
                    s.price as servicePrice,
                    c.name as categoryName,
                    u.name as clientName,
                    u.email as clientEmail
                FROM orders o
                JOIN services s ON o.serviceId = s.id
                JOIN categories c ON s.categoryId = c.id
                JOIN users u ON o.clientId = u.id
                WHERE o.masterId = ?
                ORDER BY
                    CASE o.status
                        WHEN 'NEW' THEN 1
                        WHEN 'ACCEPTED' THEN 2
                        WHEN 'DONE' THEN 3
                        WHEN 'REJECTED' THEN 4
                        WHEN 'CANCELLED' THEN 5
                    END,
                    o.desired_datetime ASC
            `).all(user.id);
        }

        // Санитизируем все заказы
        const safeOrders = orders.map(sanitizeOrder);
        res.json(safeOrders);
    } catch (error) {
        console.error('Ошибка получения заказов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение заказа по ID
router.get('/:id', authenticateToken, (req, res) => {
    try {
        const orderId = Number(req.params.id);
        const user = req.user;
        
        if (isNaN(orderId) || orderId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор заказа' });
        }

        const order = db.prepare(`
            SELECT
                o.*,
                s.title as serviceTitle,
                s.description as serviceDescription,
                s.price as servicePrice,
                c.id as categoryId,
                c.name as categoryName,
                m.id as masterId,
                m.name as masterName,
                m.email as masterEmail,
                cl.id as clientId,
                cl.name as clientName,
                cl.email as clientEmail
            FROM orders o
            JOIN services s ON o.serviceId = s.id
            JOIN categories c ON s.categoryId = c.id
            JOIN users m ON o.masterId = m.id
            JOIN users cl ON o.clientId = cl.id
            WHERE o.id = ?
        `).get(orderId);

        if (!order) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }

        if (user.role === 'client' && order.clientId !== user.id) {
            return res.status(403).json({ error: 'У вас нет прав для просмотра этого заказа' });
        }

        if (user.role === 'master' && order.masterId !== user.id) {
            return res.status(403).json({ error: 'У вас нет прав для просмотра этого заказа' });
        }

        const safeOrder = sanitizeOrder(order);
        res.json(safeOrder);
    } catch (error) {
        console.error('Ошибка получения заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Создание заказа
router.post('/', authenticateToken, requireClient, (req, res) => {
    try {
        const { serviceId, desired_datetime, comment } = req.body;
        const clientId = req.user.id;

        if (!serviceId || !desired_datetime) {
            return res.status(400).json({ error: 'serviceId и desired_datetime обязательны' });
        }

        const serviceIdNum = Number(serviceId);
        if (isNaN(serviceIdNum) || serviceIdNum <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор услуги' });
        }

        const service = Service.getById.get(serviceIdNum);
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }

        if (service.masterId === clientId) {
            return res.status(400).json({ error: 'Нельзя заказать свою собственную услугу' });
        }

        const dateParts = parsePseudoUtcParts(desired_datetime);
        if (!dateParts) {
            return res.status(400).json({ error: 'Неверный формат даты', code: 'INVALID_DATETIME' });
        }

        if (getPseudoUtcComparableTimestamp(desired_datetime) < getCurrentComparableTimestamp()) {
            return res.status(400).json({ error: 'Нельзя создать заявку на прошедшее время', code: 'PAST_TIME' });
        }

        // Проверяем, что дата не слишком далекая (максимум 1 год)
        const maxDate = new Date();
        maxDate.setFullYear(maxDate.getFullYear() + 1);
        if (getPseudoUtcComparableTimestamp(desired_datetime) > maxDate.getTime()) {
            return res.status(400).json({ error: 'Нельзя создать заявку более чем на год вперед', code: 'DATE_TOO_FAR' });
        }

        try {
            assertSlotFree(service.masterId, desired_datetime);
        } catch (e) {
            return res.status(e.status || 400).json({ error: e.message, code: e.code || 'ORDER_VALIDATION_ERROR' });
        }

        const safeComment = validateComment(comment);

        const result = Order.create.run(
            serviceIdNum,
            service.masterId,
            clientId,
            safeComment,
            desired_datetime
        );

        const newOrder = Order.getById.get(result.lastInsertRowid);
        const safeOrder = sanitizeOrder(newOrder);
        
        createOrderCreatedNotifications(newOrder);

        res.status(201).json(safeOrder);
    } catch (error) {
        console.error('Ошибка создания заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление статуса заказа
router.patch('/:id/status', authenticateToken, (req, res) => {
    try {
        const orderId = Number(req.params.id);
        const { status, reason } = req.body;
        const user = req.user;
        
        if (isNaN(orderId) || orderId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор заказа' });
        }

        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({
                error: 'Неверный статус. Допустимые значения: ' + VALID_STATUSES.join(', ')
            });
        }

        const order = Order.getById.get(orderId);
        if (!order) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }

        const previousStatus = order.status;
        let safeReason = null;

        if (user.role === 'client') {
            if (order.clientId !== user.id) {
                return res.status(403).json({ error: 'У вас нет прав для изменения этого заказа' });
            }

            if (status !== 'CANCELLED') {
                return res.status(403).json({ error: 'Клиент может только отменить заказ' });
            }

            if (order.status === 'DONE' || order.status === 'REJECTED') {
                return res.status(400).json({ error: 'Нельзя отменить заказ со статусом ' + order.status });
            }
            
            safeReason = validateReason(reason);
        } else if (user.role === 'master') {
            if (order.masterId !== user.id) {
                return res.status(403).json({ error: 'У вас нет прав для изменения этого заказа' });
            }

            const validTransitions = {
                NEW: ['ACCEPTED', 'REJECTED'],
                ACCEPTED: ['DONE'],
                REJECTED: [],
                DONE: [],
                CANCELLED: []
            };

            if (!validTransitions[order.status].includes(status)) {
                return res.status(400).json({ error: `Из статуса ${order.status} нельзя перейти в ${status}` });
            }
            
            safeReason = validateReason(reason);
        } else {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        Order.updateStatus.run(status, safeReason, orderId);

        const updatedOrder = Order.getById.get(orderId);

        if (['REJECTED', 'CANCELLED', 'DONE'].includes(status)) {
            removeOrderReminderNotifications(orderId);
        } else {
            syncOrderReminderNotifications(updatedOrder);
        }

        createOrderStatusNotifications({
            order: updatedOrder,
            previousStatus,
            actorRole: user.role,
            reason: safeReason
        });

        const safeOrder = sanitizeOrder(updatedOrder);
        res.json(safeOrder);
    } catch (error) {
        console.error('Ошибка обновления статуса заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Переназначение времени заказа
router.patch('/:id/reschedule', authenticateToken, requireClient, (req, res) => {
    try {
        const orderId = Number(req.params.id);
        const { desired_datetime, comment } = req.body || {};
        const clientId = req.user.id;
        
        if (isNaN(orderId) || orderId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор заказа' });
        }

        if (!desired_datetime) {
            return res.status(400).json({ error: 'desired_datetime обязателен' });
        }

        const order = Order.getById.get(orderId);
        if (!order) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }

        if (order.clientId !== clientId) {
            return res.status(403).json({ error: 'Вы можете изменять только свои заказы' });
        }

        if (!['NEW', 'ACCEPTED'].includes(order.status)) {
            return res.status(400).json({ error: 'Изменить время можно только у активной заявки', code: 'ORDER_NOT_ACTIVE' });
        }

        const dateParts = parsePseudoUtcParts(desired_datetime);
        if (!dateParts) {
            return res.status(400).json({ error: 'Неверный формат даты', code: 'INVALID_DATETIME' });
        }

        if (getPseudoUtcComparableTimestamp(desired_datetime) < getCurrentComparableTimestamp()) {
            return res.status(400).json({ error: 'Нельзя переназначить заявку на прошедшее время', code: 'PAST_TIME' });
        }

        // Проверяем, что дата не слишком далекая
        const maxDate = new Date();
        maxDate.setFullYear(maxDate.getFullYear() + 1);
        if (getPseudoUtcComparableTimestamp(desired_datetime) > maxDate.getTime()) {
            return res.status(400).json({ error: 'Нельзя переназначить заявку более чем на год вперед', code: 'DATE_TOO_FAR' });
        }

        try {
            assertSlotFree(order.masterId, desired_datetime, { excludeOrderId: orderId });
        } catch (e) {
            return res.status(e.status || 400).json({ error: e.message, code: e.code || 'ORDER_VALIDATION_ERROR' });
        }

        const previousDesiredDatetime = order.desired_datetime;
        const safeComment = validateComment(comment);
        const nextComment = safeComment !== null ? safeComment : order.comment;

        Order.reschedule.run(desired_datetime, nextComment, orderId);

        const updatedOrder = Order.getById.get(orderId);
        
        createOrderRescheduledNotifications({
            order: updatedOrder,
            previousDesiredDatetime,
            actorRole: req.user.role
        });

        const safeOrder = sanitizeOrder(updatedOrder);
        res.json(safeOrder);
    } catch (error) {
        console.error('Ошибка переназначения заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// PUT методы для обратной совместимости
router.put('/:id/reschedule', authenticateToken, requireClient, (req, res) => {
    req.method = 'PATCH';
    return router.handle(req, res);
});

router.put('/:id/status', authenticateToken, (req, res) => {
    req.method = 'PATCH';
    return router.handle(req, res);
});

export default router;