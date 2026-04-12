// server/routes/availability.js
import express from 'express';
import { db, Availability } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// Расписание по умолчанию
const DEFAULT_AVAILABILITY = {
    slotMinutes: 30,
    weekTemplate: {
        0: [],
        1: [["09:00","13:00"],["14:00","18:00"]],
        2: [["09:00","13:00"],["14:00","18:00"]],
        3: [["09:00","13:00"],["14:00","18:00"]],
        4: [["09:00","13:00"],["14:00","18:00"]],
        5: [["10:00","16:00"]],
        6: [["10:00","14:00"]]
    },
    exceptions: {}
};

// Вспомогательная функция для валидации времени
function isValidTimeString(time) {
    return typeof time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
}

function isValidIntervals(intervals) {
    if (!Array.isArray(intervals)) return false;
    if (intervals.length === 0) return true; // Пустой массив - валидный
    
    return intervals.every(interval => {
        if (!Array.isArray(interval) || interval.length !== 2) return false;
        const [start, end] = interval;
        if (!isValidTimeString(start) || !isValidTimeString(end)) return false;
        
        const [startHour, startMin] = start.split(':').map(Number);
        const [endHour, endMin] = end.split(':').map(Number);
        const startMinutes = startHour * 60 + startMin;
        let endMinutes = endHour * 60 + endMin;
        
        // Если время окончания меньше или равно времени начала - невалидно
        if (endMinutes <= startMinutes) return false;
        
        // Проверяем, что интервал не превышает 24 часа
        if (endMinutes - startMinutes > 24 * 60) return false;
        
        return true;
    });
}

// Вспомогательная функция для санитизации расписания
const sanitizeAvailability = (data) => {
    if (!data) return null;
    
    return {
        masterId: parseInt(data.masterId),
        slotMinutes: Math.min(120, Math.max(15, parseInt(data.slotMinutes) || 30)),
        weekTemplate: data.weekTemplate,
        exceptions: data.exceptions || {}
    };
};

// Публичный маршрут - получить расписание (не требует авторизации)
router.get('/:masterId', (req, res) => {
    try {
        const masterId = parseInt(req.params.masterId);
        
        // Валидация ID
        if (isNaN(masterId) || masterId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
        const availability = Availability.getByMaster.get(masterId);
        
        if (!availability) {
            return res.json({
                masterId,
                ...DEFAULT_AVAILABILITY
            });
        }
        
        // Безопасно парсим JSON
        let weekTemplate, exceptions;
        try {
            weekTemplate = JSON.parse(availability.weekTemplate);
            exceptions = JSON.parse(availability.exceptions || '{}');
        } catch (parseError) {
            console.error('Ошибка парсинга расписания:', parseError);
            weekTemplate = DEFAULT_AVAILABILITY.weekTemplate;
            exceptions = {};
        }
        
        res.json({
            masterId: availability.masterId,
            slotMinutes: Math.min(120, Math.max(15, availability.slotMinutes)),
            weekTemplate,
            exceptions
        });
    } catch (error) {
        console.error('Ошибка получения расписания:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Защищенный маршрут - сохранить расписание (требует авторизацию мастера)
router.put('/:masterId', authenticateToken, async (req, res) => {
    try {
        const masterId = parseInt(req.params.masterId);
        
        // Валидация ID
        if (isNaN(masterId) || masterId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
        // Проверяем, что мастер сохраняет свое расписание
        if (req.user.id !== masterId) {
            return res.status(403).json({ error: 'Вы можете изменять только свое расписание' });
        }
        
        if (req.user.role !== 'master') {
            return res.status(403).json({ error: 'Только мастера могут изменять расписание' });
        }
        
        const { slotMinutes, weekTemplate, exceptions } = req.body;
        
        // Валидация slotMinutes
        if (!slotMinutes || typeof slotMinutes !== 'number' || slotMinutes < 15 || slotMinutes > 120) {
            return res.status(400).json({ error: 'slotMinutes должен быть числом от 15 до 120' });
        }
        
        // Валидация weekTemplate
        if (!weekTemplate || typeof weekTemplate !== 'object') {
            return res.status(400).json({ error: 'weekTemplate обязателен и должен быть объектом' });
        }
        
        // Валидация всех дней недели
        const validDays = [0, 1, 2, 3, 4, 5, 6];
        for (const day of validDays) {
            const intervals = weekTemplate[day] || [];
            if (!isValidIntervals(intervals)) {
                return res.status(400).json({ 
                    error: `Неверный формат интервалов для дня ${day}` 
                });
            }
        }
        
        // Валидация исключений
        const validatedExceptions = exceptions || {};
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        
        for (const [date, intervals] of Object.entries(validatedExceptions)) {
            if (!dateRegex.test(date)) {
                return res.status(400).json({ 
                    error: `Неверный формат даты в исключениях: ${date}. Используйте YYYY-MM-DD` 
                });
            }
            
            // Проверяем, что дата не слишком старая (не более года назад)
            const exceptionDate = new Date(date);
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
            
            if (exceptionDate < oneYearAgo) {
                return res.status(400).json({ 
                    error: `Дата ${date} слишком старая. Исключения только за последний год` 
                });
            }
            
            // Проверяем, что дата не слишком далекая (максимум 2 года вперед)
            const twoYearsLater = new Date();
            twoYearsLater.setFullYear(twoYearsLater.getFullYear() + 2);
            
            if (exceptionDate > twoYearsLater) {
                return res.status(400).json({ 
                    error: `Дата ${date} слишком далекая. Максимум 2 года вперед` 
                });
            }
            
            if (!isValidIntervals(intervals)) {
                return res.status(400).json({ 
                    error: `Неверный формат интервалов для даты ${date}` 
                });
            }
        }
        
        // Санитизируем данные (экранируем только строки, JSON оставляем как есть)
        const safeSlotMinutes = Math.min(120, Math.max(15, slotMinutes));
        const safeWeekTemplate = JSON.stringify(weekTemplate);
        const safeExceptions = JSON.stringify(validatedExceptions);
        
        // Сохраняем расписание
        Availability.upsert.run(
            masterId,
            safeSlotMinutes,
            safeWeekTemplate,
            safeExceptions
        );
        
        console.log(`Расписание для мастера ${masterId} сохранено`);
        
        // Возвращаем обновленное расписание
        const updated = Availability.getByMaster.get(masterId);
        res.json({
            masterId: updated.masterId,
            slotMinutes: updated.slotMinutes,
            weekTemplate: JSON.parse(updated.weekTemplate),
            exceptions: JSON.parse(updated.exceptions || '{}')
        });
        
    } catch (error) {
        console.error('Ошибка сохранения расписания:', error);
        // Не показываем детали ошибки в production
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получить слоты на конкретную дату
router.get('/:masterId/slots', (req, res) => {
    try {
        const masterId = parseInt(req.params.masterId);
        const { date } = req.query;
        
        // Валидация ID
        if (isNaN(masterId) || masterId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор мастера' });
        }
        
        // Валидация даты
        if (!date) {
            return res.status(400).json({ error: 'Параметр date обязателен (YYYY-MM-DD)' });
        }
        
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({ error: 'Неверный формат даты. Используйте YYYY-MM-DD' });
        }
        
        // Проверяем, что дата не слишком старая
        const requestedDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        
        if (requestedDate < twoYearsAgo) {
            return res.status(400).json({ error: 'Дата слишком старая (более 2 лет назад)' });
        }
        
        // Получаем расписание мастера
        const availability = Availability.getByMaster.get(masterId);
        
        if (!availability) {
            return res.json({ slotMinutes: 30, slots: [] });
        }
        
        let weekTemplate, exceptions;
        try {
            weekTemplate = JSON.parse(availability.weekTemplate);
            exceptions = JSON.parse(availability.exceptions || '{}');
        } catch (parseError) {
            console.error('Ошибка парсинга расписания:', parseError);
            weekTemplate = DEFAULT_AVAILABILITY.weekTemplate;
            exceptions = {};
        }
        
        const slotMinutes = Math.min(120, Math.max(15, availability.slotMinutes));
        
        // Создаем дату в UTC, чтобы избежать проблем с часовыми поясами
        const [year, month, day] = date.split('-').map(Number);
        const dateObj = new Date(Date.UTC(year, month - 1, day));
        const dayOfWeek = dateObj.getUTCDay();
        
        // Проверяем исключения
        if (exceptions[date] && exceptions[date].length === 0) {
            return res.json({ slotMinutes, slots: [] });
        }
        
        // Получаем интервалы для этого дня
        let intervals = exceptions[date] || weekTemplate[dayOfWeek] || [];
        
        if (!intervals || intervals.length === 0) {
            return res.json({ slotMinutes, slots: [] });
        }
        
        // Получаем все занятые слоты с параметризованным запросом
        const busyOrders = db.prepare(`
            SELECT desired_datetime 
            FROM orders 
            WHERE masterId = ? 
            AND date(desired_datetime) = ?
            AND status IN ('NEW', 'ACCEPTED')
        `).all(masterId, date);
        
        const busySet = new Set();
        busyOrders.forEach(order => {
            if (order.desired_datetime) {
                busySet.add(order.desired_datetime);
            }
        });
        
        // Генерируем слоты
        const slots = [];
        const maxSlots = 100; // Ограничение на количество слотов
        
        for (const [start, end] of intervals) {
        const [startHour, startMin] = start.split(':').map(Number);
        const [endHour, endMin] = end.split(':').map(Number);
        
        const startTotal = startHour * 60 + startMin;
        let endTotal = endHour * 60 + endMin;
        
        if (endTotal < startTotal) {
            endTotal += 24 * 60;
        }

        if (endTotal - startTotal < slotMinutes) {
            continue;
        }        
        
        for (let minutes = startTotal; minutes + slotMinutes <= endTotal; minutes += slotMinutes) {
                const currentHour = Math.floor(minutes / 60) % 24;
                const currentMin = minutes % 60;
                
                // Вычисляем время окончания слота
                const endMinutesTotal = minutes + slotMinutes;
                let endHour2 = Math.floor(endMinutesTotal / 60);
                let endMinute2 = endMinutesTotal % 60;
                let endDay = 0;
                
                if (endHour2 >= 24) {
                    endHour2 -= 24;
                    endDay = 1;
                }
                
                // Формируем ISO строки
                const startISO = `${date}T${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}:00.000Z`;
                
                let endDate = date;
                if (endDay === 1) {
                    const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
                    endDate = nextDay.toISOString().split('T')[0];
                }
                const endISO = `${endDate}T${endHour2.toString().padStart(2, '0')}:${endMinute2.toString().padStart(2, '0')}:00.000Z`;
                
                slots.push({
                    start: startISO,
                    end: endISO,
                    status: busySet.has(startISO) ? 'busy' : 'free'
                });
            }
        }
        
        // Сортируем слоты по времени
        slots.sort((a, b) => a.start.localeCompare(b.start));
        
        res.json({
            slotMinutes,
            slots,
            _count: slots.length,
            _date: date
        });
        
    } catch (error) {
        console.error('Ошибка получения слотов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;