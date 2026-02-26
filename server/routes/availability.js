// server/routes/availability.js (исправленная версия)
import express from 'express';
import { db, Availability } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';

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
    return intervals.every(interval => {
        if (!Array.isArray(interval) || interval.length !== 2) return false;
        const [start, end] = interval;
        if (!isValidTimeString(start) || !isValidTimeString(end)) return false;
        
        const [startHour, startMin] = start.split(':').map(Number);
        const [endHour, endMin] = end.split(':').map(Number);
        const startMinutes = startHour * 60 + startMin;
        const endMinutes = endHour * 60 + endMin;
        
        return startMinutes < endMinutes;
    });
}

// Публичный маршрут - получить расписание (не требует авторизации)
router.get('/:masterId', (req, res) => {
    try {
        const masterId = parseInt(req.params.masterId);
        
        const availability = Availability.getByMaster.get(masterId);
        
        if (!availability) {
            return res.json({
                masterId,
                ...DEFAULT_AVAILABILITY
            });
        }
        
        res.json({
            masterId: availability.masterId,
            slotMinutes: availability.slotMinutes,
            weekTemplate: JSON.parse(availability.weekTemplate),
            exceptions: JSON.parse(availability.exceptions || '{}')
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
        
        // Проверяем, что мастер сохраняет свое расписание
        if (req.user.id !== masterId) {
            return res.status(403).json({ error: 'Вы можете изменять только свое расписание' });
        }
        
        if (req.user.role !== 'master') {
            return res.status(403).json({ error: 'Только мастера могут изменять расписание' });
        }
        
        const { slotMinutes, weekTemplate, exceptions } = req.body;
        
        // Валидация
        if (!slotMinutes || typeof slotMinutes !== 'number' || slotMinutes < 15 || slotMinutes > 120) {
            return res.status(400).json({ error: 'slotMinutes должен быть числом от 15 до 120' });
        }
        
        if (!weekTemplate || typeof weekTemplate !== 'object') {
            return res.status(400).json({ error: 'weekTemplate обязателен и должен быть объектом' });
        }
        
        // Валидация weekTemplate
        for (let day = 0; day <= 6; day++) {
            const intervals = weekTemplate[day] || [];
            if (!isValidIntervals(intervals)) {
                return res.status(400).json({ 
                    error: `Неверный формат интервалов для дня ${day}` 
                });
            }
        }
        
        // Валидация исключений
        const validatedExceptions = exceptions || {};
        for (const [date, intervals] of Object.entries(validatedExceptions)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({ 
                    error: `Неверный формат даты в исключениях: ${date}` 
                });
            }
            if (!isValidIntervals(intervals)) {
                return res.status(400).json({ 
                    error: `Неверный формат интервалов для даты ${date}` 
                });
            }
        }
        
        // Сохраняем расписание
        Availability.upsert.run(
            masterId,
            slotMinutes,
            JSON.stringify(weekTemplate),
            JSON.stringify(validatedExceptions)
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
        res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + error.message });
    }
});

// Получить слоты на конкретную дату (исправленная версия)
router.get('/:masterId/slots', (req, res) => {
    try {
        const masterId = parseInt(req.params.masterId);
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({ error: 'Параметр date обязателен (YYYY-MM-DD)' });
        }
        
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Неверный формат даты. Используйте YYYY-MM-DD' });
        }
        
        // Получаем расписание мастера
        const availability = Availability.getByMaster.get(masterId);
        
        if (!availability) {
            return res.json({ slotMinutes: 30, slots: [] });
        }
        
        const weekTemplate = JSON.parse(availability.weekTemplate);
        const exceptions = JSON.parse(availability.exceptions || '{}');
        const slotMinutes = availability.slotMinutes;
        
        // Создаем дату в UTC, чтобы избежать проблем с часовыми поясами
        const [year, month, day] = date.split('-').map(Number);
        const dateObj = new Date(Date.UTC(year, month - 1, day));
        const dayOfWeek = dateObj.getUTCDay(); // 0 = воскресенье, 1 = понедельник и т.д.
        
        console.log(`Дата: ${date}, день недели: ${dayOfWeek}`);
        
        // Проверяем исключения
        if (exceptions[date] && exceptions[date].length === 0) {
            return res.json({ slotMinutes, slots: [] });
        }
        
        // Получаем интервалы для этого дня
        let intervals = exceptions[date] || weekTemplate[dayOfWeek] || [];
        
        console.log('Интервалы:', intervals);
        
        if (!intervals || intervals.length === 0) {
            return res.json({ slotMinutes, slots: [] });
        }
        
        // Получаем все занятые слоты
        const busyOrders = db.prepare(`
            SELECT desired_datetime 
            FROM orders 
            WHERE masterId = ? 
            AND date(desired_datetime) = ?
            AND status IN ('NEW', 'ACCEPTED')
        `).all(masterId, date);
        
        const busySet = new Set();
        busyOrders.forEach(order => {
            busySet.add(order.desired_datetime);
        });
        
        // Генерируем слоты
        const slots = [];
        
        intervals.forEach(([start, end]) => {
            const [startHour, startMin] = start.split(':').map(Number);
            const [endHour, endMin] = end.split(':').map(Number);
            
            const startTotal = startHour * 60 + startMin;
            let endTotal = endHour * 60 + endMin;
            
            // Если время окончания меньше времени начала, значит это следующий день
            if (endTotal < startTotal) {
                endTotal += 24 * 60; // Добавляем 24 часа
            }
            
            for (let minutes = startTotal; minutes + slotMinutes <= endTotal; minutes += slotMinutes) {
                const currentHour = Math.floor(minutes / 60);
                const currentMin = minutes % 60;
                
                // Вычисляем время окончания слота
                const endMinutesTotal = minutes + slotMinutes;
                let endHour2 = Math.floor(endMinutesTotal / 60);
                let endMinute2 = endMinutesTotal % 60;
                let endDay = 0; // 0 = тот же день, 1 = следующий день
                
                // Если перешли на следующий день
                if (endHour2 >= 24) {
                    endHour2 -= 24;
                    endDay = 1;
                }
                
                // Формируем ISO строки
                const startISO = `${date}T${currentHour.toString().padStart(2, '0')}:${currentMin.toString().padStart(2, '0')}:00.000Z`;
                
                // Для окончания используем следующую дату если нужно
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
        });
        
        // Сортируем слоты по времени
        slots.sort((a, b) => a.start.localeCompare(b.start));
        
        res.json({
            slotMinutes,
            slots
        });
        
    } catch (error) {
        console.error('Ошибка получения слотов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + error.message });
    }
});

export default router;