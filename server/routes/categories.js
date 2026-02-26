// server/routes/categories.js
import express from 'express';
import { db, Category } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';

const router = express.Router();

// Получение всех категорий (доступно всем)
router.get('/', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT * FROM categories ORDER BY name
        `).all();
        
        res.json(categories);
    } catch (error) {
        console.error('Ошибка получения категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение категории по ID
router.get('/:id', (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        
        const category = db.prepare(`
            SELECT * FROM categories WHERE id = ?
        `).get(categoryId);
        
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Получаем количество услуг в этой категории
        const servicesCount = db.prepare(`
            SELECT COUNT(*) as count FROM services WHERE categoryId = ?
        `).get(categoryId);
        
        res.json({
            ...category,
            servicesCount: servicesCount.count
        });
    } catch (error) {
        console.error('Ошибка получения категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Создание новой категории (только для мастеров)
router.post('/', authenticateToken, requireMaster, (req, res) => {
    try {
        const { name } = req.body;
        
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        // Проверяем, существует ли уже такая категория
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ?
        `).get(trimmedName);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // Создаем категорию
        const result = Category.create.run(trimmedName);
        const newCategory = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
        
        res.status(201).json(newCategory);
    } catch (error) {
        console.error('Ошибка создания категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление категории (только для мастеров)
router.put('/:id', authenticateToken, requireMaster, (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        const { name } = req.body;
        
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        // Проверяем существование категории
        const category = Category.getById.get(categoryId);
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Проверяем, не занято ли новое имя другой категорией
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ? AND id != ?
        `).get(trimmedName, categoryId);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // Обновляем категорию
        Category.update.run(trimmedName, categoryId);
        const updatedCategory = Category.getById.get(categoryId);
        
        res.json(updatedCategory);
    } catch (error) {
        console.error('Ошибка обновления категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление категории (только для мастеров)
router.delete('/:id', authenticateToken, requireMaster, (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        
        // Проверяем существование категории
        const category = Category.getById.get(categoryId);
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Проверяем, есть ли услуги в этой категории
        const servicesCount = db.prepare(`
            SELECT COUNT(*) as count FROM services WHERE categoryId = ?
        `).get(categoryId);
        
        if (servicesCount.count > 0) {
            return res.status(400).json({ 
                error: 'Нельзя удалить категорию, в которой есть услуги',
                servicesCount: servicesCount.count
            });
        }
        
        // Удаляем категорию
        Category.delete.run(categoryId);
        
        res.json({ 
            message: 'Категория успешно удалена',
            id: categoryId 
        });
    } catch (error) {
        console.error('Ошибка удаления категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;