// server/routes/services.js
import express from 'express';
import { db, Service, Category } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============

// Санитизация услуги
function sanitizeService(service) {
    if (!service) return null;
    
    const sanitized = { ...service };
    
    // Строковые поля
    const stringFields = ['title', 'description', 'categoryName', 'masterName', 'masterEmail'];
    
    for (const field of stringFields) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            if (typeof sanitized[field] === 'string') {
                sanitized[field] = escapeHtml(sanitized[field]);
            }
        }
    }
    
    // Числовые поля
    const numberFields = ['id', 'categoryId', 'masterId', 'price', 'totalOrders', 'completedOrders'];
    
    for (const field of numberFields) {
        if (sanitized[field] !== undefined && sanitized[field] !== null) {
            sanitized[field] = Number(sanitized[field]) || 0;
        }
    }
    
    return sanitized;
}

// Валидация цены
function validatePrice(price) {
    const numPrice = Number(price);
    if (isNaN(numPrice)) return null;
    if (!Number.isInteger(numPrice)) return null;
    if (numPrice < 1) return null;
    if (numPrice > 10000000) return null; // Максимум 10 млн
    return numPrice;
}

// Валидация названия услуги
function validateTitle(title) {
    if (!title || typeof title !== 'string') return null;
    const trimmed = title.trim();
    if (trimmed.length < 3) return null;
    if (trimmed.length > 200) return null;
    // Запрещаем опасные символы
    const safeRegex = /^[а-яА-Яa-zA-Z0-9\s\-.,!?()№"']+$/u;
    if (!safeRegex.test(trimmed)) return null;
    return escapeHtml(trimmed);
}

// Валидация описания
function validateDescription(description) {
    if (!description) return null;
    if (typeof description !== 'string') return null;
    const trimmed = description.trim();
    if (trimmed.length > 5000) return null;
    return escapeHtml(trimmed);
}

// Получение всех услуг с фильтрацией
router.get('/', (req, res) => {
    try {
        const { categoryId, masterId, search, minPrice, maxPrice } = req.query;
        
        let sql = `
            SELECT 
                s.*,
                c.name as categoryName,
                u.name as masterName,
                (SELECT COUNT(*) FROM orders WHERE serviceId = s.id AND status = 'DONE') as completedOrders
            FROM services s
            JOIN categories c ON s.categoryId = c.id
            JOIN users u ON s.masterId = u.id
            WHERE 1=1
        `;
        
        const params = [];
        
        // Валидация и добавление параметров
        if (categoryId) {
            const catId = parseInt(categoryId);
            if (!isNaN(catId) && catId > 0) {
                sql += ` AND s.categoryId = ?`;
                params.push(catId);
            }
        }
        
        if (masterId) {
            const mastId = parseInt(masterId);
            if (!isNaN(mastId) && mastId > 0) {
                sql += ` AND s.masterId = ?`;
                params.push(mastId);
            }
        }
        
        if (search && typeof search === 'string') {
            const safeSearch = search.trim();
            if (safeSearch.length > 0 && safeSearch.length <= 100) {
                sql += ` AND (s.title LIKE ? OR s.description LIKE ?)`;
                const searchTerm = `%${safeSearch}%`;
                params.push(searchTerm, searchTerm);
            }
        }
        
        if (minPrice) {
            const minP = parseInt(minPrice);
            if (!isNaN(minP) && minP >= 0) {
                sql += ` AND s.price >= ?`;
                params.push(minP);
            }
        }
        
        if (maxPrice) {
            const maxP = parseInt(maxPrice);
            if (!isNaN(maxP) && maxP > 0 && maxP <= 10000000) {
                sql += ` AND s.price <= ?`;
                params.push(maxP);
            }
        }
        
        sql += ` ORDER BY s.created_at DESC LIMIT 100`; // Лимит для защиты
        
        const services = db.prepare(sql).all(...params);
        const safeServices = services.map(sanitizeService);
        
        res.json(safeServices);
    } catch (error) {
        console.error('Ошибка получения услуг:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение услуги по ID
router.get('/:id', (req, res) => {
    try {
        const serviceId = parseInt(req.params.id);
        
        if (isNaN(serviceId) || serviceId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор услуги' });
        }
        
        const service = db.prepare(`
            SELECT 
                s.*,
                c.id as categoryId,
                c.name as categoryName,
                u.id as masterId,
                u.name as masterName,
                u.email as masterEmail,
                (SELECT COUNT(*) FROM orders WHERE serviceId = s.id) as totalOrders,
                (SELECT COUNT(*) FROM orders WHERE serviceId = s.id AND status = 'DONE') as completedOrders
            FROM services s
            JOIN categories c ON s.categoryId = c.id
            JOIN users u ON s.masterId = u.id
            WHERE s.id = ?
        `).get(serviceId);
        
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }
        
        const safeService = sanitizeService(service);
        res.json(safeService);
    } catch (error) {
        console.error('Ошибка получения услуги:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Создание новой услуги (только для мастеров)
router.post('/', authenticateToken, requireMaster, (req, res) => {
    try {
        const { categoryId, title, description, price } = req.body;
        const masterId = req.user.id;
        
        // Валидация categoryId
        const catId = parseInt(categoryId);
        if (isNaN(catId) || catId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории', code: 'VALIDATION_ERROR' });
        }
        
        // Валидация названия
        const safeTitle = validateTitle(title);
        if (!safeTitle) {
            return res.status(400).json({ 
                error: 'Название услуги должно содержать от 3 до 200 символов и только буквы, цифры, пробелы и базовую пунктуацию',
                code: 'INVALID_TITLE'
            });
        }
        
        // Валидация цены
        const safePrice = validatePrice(price);
        if (safePrice === null) {
            return res.status(400).json({ 
                error: 'Цена должна быть целым положительным числом от 1 до 10 000 000',
                code: 'INVALID_PRICE',
                minPrice: 1,
                maxPrice: 10000000
            });
        }
        
        // Валидация описания
        const safeDescription = validateDescription(description);
        
        // Проверяем существование категории
        const category = Category.getById.get(catId);
        if (!category) {
            return res.status(400).json({ error: 'Указанная категория не существует' });
        }
        
        // Создаем услугу
        const result = Service.create.run(
            masterId,
            catId,
            safeTitle,
            safeDescription,
            safePrice
        );
        
        const newService = db.prepare(`
            SELECT s.*, c.name as categoryName 
            FROM services s
            JOIN categories c ON s.categoryId = c.id
            WHERE s.id = ?
        `).get(result.lastInsertRowid);
        
        const safeService = sanitizeService(newService);
        res.status(201).json(safeService);
    } catch (error) {
        console.error('Ошибка создания услуги:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление услуги (только мастер, создавший услугу)
router.put('/:id', authenticateToken, requireMaster, (req, res) => {
    try {
        const serviceId = parseInt(req.params.id);
        const masterId = req.user.id;
        const { categoryId, title, description, price } = req.body;
        
        if (isNaN(serviceId) || serviceId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор услуги' });
        }
        
        // Проверяем существование услуги
        const service = Service.getById.get(serviceId);
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }
        
        // Проверяем, что услуга принадлежит этому мастеру
        if (service.masterId !== masterId) {
            return res.status(403).json({ error: 'Вы можете редактировать только свои услуги' });
        }
        
        // Валидация categoryId
        const catId = parseInt(categoryId);
        if (isNaN(catId) || catId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории', code: 'VALIDATION_ERROR' });
        }
        
        // Валидация названия
        const safeTitle = validateTitle(title);
        if (!safeTitle) {
            return res.status(400).json({ 
                error: 'Название услуги должно содержать от 3 до 200 символов и только буквы, цифры, пробелы и базовую пунктуацию',
                code: 'INVALID_TITLE'
            });
        }
        
        // Валидация цены
        const safePrice = validatePrice(price);
        if (safePrice === null) {
            return res.status(400).json({ 
                error: 'Цена должна быть целым положительным числом от 1 до 10 000 000',
                code: 'INVALID_PRICE'
            });
        }
        
        // Валидация описания
        const safeDescription = validateDescription(description);
        
        // Проверяем существование категории
        const category = Category.getById.get(catId);
        if (!category) {
            return res.status(400).json({ error: 'Указанная категория не существует' });
        }
        
        // Обновляем услугу
        Service.update.run(
            catId,
            safeTitle,
            safeDescription,
            safePrice,
            serviceId,
            masterId
        );
        
        const updatedService = Service.getById.get(serviceId);
        const safeService = sanitizeService(updatedService);
        res.json(safeService);
    } catch (error) {
        console.error('Ошибка обновления услуги:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление услуги (только мастер, создавший услугу)
router.delete('/:id', authenticateToken, requireMaster, (req, res) => {
    try {
        const serviceId = parseInt(req.params.id);
        const masterId = req.user.id;
        
        if (isNaN(serviceId) || serviceId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор услуги' });
        }
        
        // Проверяем существование услуги
        const service = Service.getById.get(serviceId);
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }
        
        // Проверяем, что услуга принадлежит этому мастеру
        if (service.masterId !== masterId) {
            return res.status(403).json({ error: 'Вы можете удалять только свои услуги' });
        }
        
        // Проверяем, есть ли активные заказы на эту услугу
        const activeOrders = db.prepare(`
            SELECT COUNT(*) as count 
            FROM orders 
            WHERE serviceId = ? AND status IN ('NEW', 'ACCEPTED')
        `).get(serviceId);
        
        if (activeOrders.count > 0) {
            return res.status(400).json({ 
                error: 'Нельзя удалить услугу, на которую есть активные заказы',
                activeOrders: activeOrders.count
            });
        }
        
        // Удаляем услугу
        Service.delete.run(serviceId, masterId);
        
        res.json({ 
            message: 'Услуга успешно удалена',
            id: serviceId 
        });
    } catch (error) {
        console.error('Ошибка удаления услуги:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;