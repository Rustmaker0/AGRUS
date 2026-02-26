// server/routes/services.js
import express from 'express';
import { db, Service, Category } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';

const router = express.Router();

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
        
        if (categoryId) {
            sql += ` AND s.categoryId = ?`;
            params.push(parseInt(categoryId));
        }
        
        if (masterId) {
            sql += ` AND s.masterId = ?`;
            params.push(parseInt(masterId));
        }
        
        if (search) {
            sql += ` AND (s.title LIKE ? OR s.description LIKE ?)`;
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }
        
        if (minPrice) {
            sql += ` AND s.price >= ?`;
            params.push(parseInt(minPrice));
        }
        
        if (maxPrice) {
            sql += ` AND s.price <= ?`;
            params.push(parseInt(maxPrice));
        }
        
        sql += ` ORDER BY s.created_at DESC`;
        
        const services = db.prepare(sql).all(...params);
        res.json(services);
    } catch (error) {
        console.error('Ошибка получения услуг:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение услуги по ID
router.get('/:id', (req, res) => {
    try {
        const serviceId = parseInt(req.params.id);
        
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
        
        res.json(service);
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
        
        // Валидация
        if (!categoryId || !title || !price) {
            return res.status(400).json({ error: 'categoryId, title и price обязательны' });
        }
        
        if (price <= 0 || !Number.isInteger(price)) {
            return res.status(400).json({ error: 'Цена должна быть положительным целым числом' });
        }
        
        const trimmedTitle = title.trim();
        if (trimmedTitle.length < 3) {
            return res.status(400).json({ error: 'Название услуги должно содержать минимум 3 символа' });
        }
        
        // Проверяем существование категории
        const category = Category.getById.get(categoryId);
        if (!category) {
            return res.status(400).json({ error: 'Указанная категория не существует' });
        }
        
        // Создаем услугу
        const result = Service.create.run(
            masterId,
            categoryId,
            trimmedTitle,
            description || null,
            price
        );
        
        const newService = db.prepare(`
            SELECT s.*, c.name as categoryName 
            FROM services s
            JOIN categories c ON s.categoryId = c.id
            WHERE s.id = ?
        `).get(result.lastInsertRowid);
        
        res.status(201).json(newService);
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
        
        // Проверяем существование услуги
        const service = Service.getById.get(serviceId);
        if (!service) {
            return res.status(404).json({ error: 'Услуга не найдена' });
        }
        
        // Проверяем, что услуга принадлежит этому мастеру
        if (service.masterId !== masterId) {
            return res.status(403).json({ error: 'Вы можете редактировать только свои услуги' });
        }
        
        // Валидация
        if (!categoryId || !title || !price) {
            return res.status(400).json({ error: 'categoryId, title и price обязательны' });
        }
        
        if (price <= 0 || !Number.isInteger(price)) {
            return res.status(400).json({ error: 'Цена должна быть положительным целым числом' });
        }
        
        const trimmedTitle = title.trim();
        if (trimmedTitle.length < 3) {
            return res.status(400).json({ error: 'Название услуги должно содержать минимум 3 символа' });
        }
        
        // Проверяем существование категории
        const category = Category.getById.get(categoryId);
        if (!category) {
            return res.status(400).json({ error: 'Указанная категория не существует' });
        }
        
        // Обновляем услугу
        Service.update.run(
            categoryId,
            trimmedTitle,
            description || null,
            price,
            serviceId,
            masterId
        );
        
        const updatedService = Service.getById.get(serviceId);
        res.json(updatedService);
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