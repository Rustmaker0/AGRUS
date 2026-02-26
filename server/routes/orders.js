// server/routes/orders.js
import express from 'express';
import { db, Order, Service, Availability } from '../database.js';
import { authenticateToken, requireClient, requireMaster } from '../middleware/auth.js';

const router = express.Router();

// Константы для статусов заказов
const BUSY_STATUSES = ['NEW', 'ACCEPTED', 'DONE'];
const VALID_STATUSES = ['NEW', 'ACCEPTED', 'REJECTED', 'DONE', 'CANCELLED'];

// Вспомогательная функция для проверки свободного слота
// Вспомогательная функция для проверки свободного слота (С ПОДРОБНЫМ ЛОГИРОВАНИЕМ)
function assertSlotFree(masterId, desiredISO) {
    console.log('\n=== НАЧАЛО ПРОВЕРКИ СЛОТА ===');
    console.log(`Мастер ID: ${masterId}`);
    console.log(`Запрошенное время (ISO): ${desiredISO}`);
    
    // Получаем расписание мастера
    const availability = Availability.getByMaster.get(masterId);
    if (!availability) {
        console.log('❌ Расписание мастера не найдено');
        throw Object.assign(new Error('Расписание мастера не задано'), { status: 400 });
    }
    
    console.log('✅ Расписание мастера найдено');
    console.log(`Длительность слота: ${availability.slotMinutes} минут`);

    const slotMinutes = availability.slotMinutes || 30;
    const weekTemplate = JSON.parse(availability.weekTemplate);
    const exceptions = JSON.parse(availability.exceptions || '{}');
    
    const dt = new Date(desiredISO);
    if (isNaN(dt)) {
        console.log('❌ Некорректная дата');
        throw Object.assign(new Error('Некорректная дата/время'), { status: 400 });
    }

    const dateStr = dt.toISOString().slice(0, 10);
    
    // ПОЛУЧАЕМ ЧАСЫ В UTC
    const hours = dt.getUTCHours();
    const minutes = dt.getUTCMinutes();
    const currentMinutes = hours * 60 + minutes;
    
    const dayOfWeek = dt.getUTCDay(); // 0 = воскресенье
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    
    console.log(`Дата: ${dateStr}, день недели: ${dayNames[dayOfWeek]} (${dayOfWeek})`);
    console.log(`Время: ${hours}:${minutes.toString().padStart(2, '0')} (${currentMinutes} минут от начала дня)`);

    // Проверяем исключения на эту дату
    if (exceptions[dateStr]) {
        console.log(`📅 Есть исключение на эту дату:`, exceptions[dateStr]);
        if (exceptions[dateStr].length === 0) {
            console.log('❌ День отмечен как выходной в исключениях');
            throw Object.assign(new Error('Мастер не работает в этот день'), { status: 400 });
        }
    }

    // Получаем рабочие интервалы для этого дня
    let intervals = exceptions[dateStr] || weekTemplate[dayOfWeek] || [];
    
    console.log('📋 Рабочие интервалы из расписания:', intervals);

    if (!intervals || intervals.length === 0) {
        console.log('❌ Нет рабочих интервалов для этого дня');
        throw Object.assign(new Error('Мастер не работает в этот день'), { status: 400 });
    }

    // Проверяем, что слот помещается в один из рабочих интервалов
    let slotValid = false;
    let validInterval = null;
    
    for (const [start, end] of intervals) {
        const [startHour, startMin] = start.split(':').map(Number);
        const [endHour, endMin] = end.split(':').map(Number);
        
        const startTotal = startHour * 60 + startMin;
        let endTotal = endHour * 60 + endMin;
        
        console.log(`Проверка интервала ${start}-${end}:`);
        console.log(`  Начало интервала: ${startTotal} мин (${start})`);
        console.log(`  Конец интервала: ${endTotal} мин (${end})`);
        console.log(`  Начало слота: ${currentMinutes} мин (${hours}:${minutes})`);
        console.log(`  Конец слота: ${currentMinutes + slotMinutes} мин`);
        
        // Если время окончания меньше времени начала, значит это следующий день
        if (endTotal < startTotal) {
            endTotal += 24 * 60;
            console.log(`  Интервал переходит на следующий день, скорректированный конец: ${endTotal} мин`);
        }
        
        // Проверяем, попадает ли начало слота в интервал
        if (currentMinutes >= startTotal && currentMinutes + slotMinutes <= endTotal) {
            slotValid = true;
            validInterval = `${start}-${end}`;
            console.log(`  ✅ Слот попадает в интервал ${start}-${end}`);
            break;
        } else {
            if (currentMinutes < startTotal) {
                console.log(`  ❌ Слишком рано (начало слота ${currentMinutes} < ${startTotal})`);
            } else if (currentMinutes + slotMinutes > endTotal) {
                console.log(`  ❌ Слишком поздно (конец слота ${currentMinutes + slotMinutes} > ${endTotal})`);
            }
        }
    }
    
    if (!slotValid) {
        console.log('❌ Слот НЕ попадает ни в один рабочий интервал');
        throw Object.assign(new Error('Выбранное время вне рабочего графика'), { status: 400 });
    }

    console.log(`✅ Слот попадает в интервал ${validInterval}`);

    // Проверяем пересечение с существующими заказами
    console.log('\n🔍 Проверка пересечения с существующими заказами:');
    
    const ms = dt.getTime();
    const me = ms + slotMinutes * 60 * 1000;
    
    const busyOrders = db.prepare(`
        SELECT id, desired_datetime, status 
        FROM orders 
        WHERE masterId = ? 
        AND status IN ('NEW', 'ACCEPTED')
        AND date(desired_datetime) = date(?)
    `).all(masterId, desiredISO);

    console.log(`Найдено ${busyOrders.length} активных заказов на эту дату`);

    for (const order of busyOrders) {
        const os = new Date(order.desired_datetime).getTime();
        const oe = os + slotMinutes * 60 * 1000;
        
        console.log(`Заказ #${order.id}: ${order.desired_datetime} (${order.status})`);
        console.log(`  Начало: ${os}, конец: ${oe}`);
        console.log(`  Наш слот: ${ms} - ${me}`);
        
        // Проверяем пересечение
        if (Math.max(ms, os) < Math.min(me, oe)) {
            console.log(`  ❌ КОНФЛИКТ! Заказ пересекается с выбранным слотом`);
            throw Object.assign(new Error('Этот слот уже занят'), { status: 409 });
        } else {
            console.log(`  ✅ Нет пересечения`);
        }
    }

    console.log('✅ Все проверки пройдены, слот свободен!');
    console.log('=== КОНЕЦ ПРОВЕРКИ ===\n');
    return true;
}

// Получение списка заказов (в зависимости от роли)
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
        
        res.json(orders);
    } catch (error) {
        console.error('Ошибка получения заказов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение заказа по ID
router.get('/:id', authenticateToken, (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const user = req.user;
        
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
        
        // Проверяем права доступа
        if (user.role === 'client' && order.clientId !== user.id) {
            return res.status(403).json({ error: 'У вас нет прав для просмотра этого заказа' });
        }
        
        if (user.role === 'master' && order.masterId !== user.id) {
            return res.status(403).json({ error: 'У вас нет прав для просмотра этого заказа' });
        }
        
        res.json(order);
    } catch (error) {
        console.error('Ошибка получения заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Создание нового заказа (только для клиентов)
router.post('/', authenticateToken, requireClient, (req, res) => {
    try {
        const { serviceId, desired_datetime, comment } = req.body;
        const clientId = req.user.id;
        
        // Валидация
        if (!serviceId || !desired_datetime) {
            return res.status(400).json({ error: 'serviceId и desired_datetime обязательны' });
        }
        
        // Проверяем существование услуги
        const service = Service.getById.get(serviceId);
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }
        
        // Проверяем, что клиент не заказывает свою услугу
        if (service.masterId === clientId) {
            return res.status(400).json({ error: 'Нельзя заказать свою собственную услугу' });
        }
        
        // Проверяем формат даты
        const dateObj = new Date(desired_datetime);
        if (isNaN(dateObj.getTime())) {
            return res.status(400).json({ error: 'Неверный формат даты' });
        }
        
        // Проверяем, что дата не в прошлом
        if (dateObj < new Date()) {
            return res.status(400).json({ error: 'Нельзя создать заказ на прошедшую дату' });
        }
        
        // Проверяем свободный слот
        try {
            assertSlotFree(service.masterId, desired_datetime);
        } catch (e) {
            return res.status(e.status || 400).json({ error: e.message });
        }
        
        // Создаем заказ
        const result = Order.create.run(
            serviceId,
            service.masterId,
            clientId,
            comment || null,
            desired_datetime
        );
        
        const newOrder = Order.getById.get(result.lastInsertRowid);
        res.status(201).json(newOrder);
        
    } catch (error) {
        console.error('Ошибка создания заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление статуса заказа
router.patch('/:id/status', authenticateToken, (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { status, reason } = req.body;
        const user = req.user;
        
        // Валидация статуса
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ 
                error: 'Неверный статус. Допустимые значения: ' + VALID_STATUSES.join(', ')
            });
        }
        
        const order = Order.getById.get(orderId);
        
        if (!order) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }
        
        // Проверяем права на изменение статуса
        if (user.role === 'client') {
            // Клиент может только отменить свой заказ
            if (order.clientId !== user.id) {
                return res.status(403).json({ error: 'У вас нет прав для изменения этого заказа' });
            }
            
            if (status !== 'CANCELLED') {
                return res.status(403).json({ error: 'Клиент может только отменить заказ' });
            }
            
            // Нельзя отменить заказ, который уже выполнен или отклонен
            if (order.status === 'DONE' || order.status === 'REJECTED') {
                return res.status(400).json({ error: 'Нельзя отменить заказ со статусом ' + order.status });
            }
            
        } else if (user.role === 'master') {
            // Мастер может менять статус только своих заказов
            if (order.masterId !== user.id) {
                return res.status(403).json({ error: 'У вас нет прав для изменения этого заказа' });
            }
            
            // Проверяем допустимость перехода статуса для мастера
            const validTransitions = {
                'NEW': ['ACCEPTED', 'REJECTED'],
                'ACCEPTED': ['DONE'],
                'REJECTED': [],
                'DONE': [],
                'CANCELLED': []
            };
            
            if (!validTransitions[order.status].includes(status)) {
                return res.status(400).json({ error: `Из статуса ${order.status} нельзя перейти в ${status}` });
            }
        }
        
        // Обновляем статус
        Order.updateStatus.run(status, reason || null, orderId);
        
        const updatedOrder = Order.getById.get(orderId);
        res.json(updatedOrder);
        
    } catch (error) {
        console.error('Ошибка обновления статуса заказа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// PUT для обратной совместимости
router.put('/:id/status', authenticateToken, (req, res) => {
    req.method = 'PATCH';
    return router.handle(req, res);
});

export default router;