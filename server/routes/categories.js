// server/routes/categories.js
import express from 'express';
import { db, Category } from '../database.js';
import { authenticateToken, requireMaster } from '../middleware/auth.js';
import escapeHtml from 'escape-html';

const router = express.Router();

// Вспомогательная функция для санитизации категории
const sanitizeCategory = (category) => {
    if (!category) return null;
    return {
        id: category.id,
        name: escapeHtml(String(category.name)),
        created_at: category.created_at
    };
};

// Вспомогательная функция для валидации имени категории
const isValidCategoryName = (name) => {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return false;
    // Запрещаем опасные символы, но разрешаем буквы, цифры, пробелы и базовую пунктуацию
    const safeRegex = /^[а-яА-Яa-zA-Z0-9\s\-.,!?()]+$/u;
    return safeRegex.test(trimmed);
};

// Получение всех категорий (доступно всем)
router.get('/', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT * FROM categories ORDER BY name
        `).all();
        
        // Санитизируем все категории перед отправкой
        const safeCategories = categories.map(sanitizeCategory);
        
        res.json(safeCategories);
    } catch (error) {
        console.error('Ошибка получения категорий:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Получение категории по ID
router.get('/:id', (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        
        // Валидация ID
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
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
        
        const safeCategory = sanitizeCategory(category);
        
        res.json({
            ...safeCategory,
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
        
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        // Валидация имени категории
        if (!isValidCategoryName(trimmedName)) {
            return res.status(400).json({ 
                error: 'Название категории должно содержать от 2 до 100 символов и только буквы, цифры, пробелы и базовую пунктуацию' 
            });
        }
        
        // Экранируем имя перед сохранением
        const safeName = escapeHtml(trimmedName);
        
        // Проверяем, существует ли уже такая категория
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ?
        `).get(safeName);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // Создаем категорию
        const result = Category.create.run(safeName);
        const newCategory = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
        const safeCategory = sanitizeCategory(newCategory);
        
        res.status(201).json(safeCategory);
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
        
        // Валидация ID
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        // Валидация имени категории
        if (!isValidCategoryName(trimmedName)) {
            return res.status(400).json({ 
                error: 'Название категории должно содержать от 2 до 100 символов и только буквы, цифры, пробелы и базовую пунктуацию' 
            });
        }
        
        // Проверяем существование категории
        const category = Category.getById.get(categoryId);
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // Экранируем имя
        const safeName = escapeHtml(trimmedName);
        
        // Проверяем, не занято ли новое имя другой категорией
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ? AND id != ?
        `).get(safeName, categoryId);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // Обновляем категорию
        Category.update.run(safeName, categoryId);
        const updatedCategory = Category.getById.get(categoryId);
        const safeCategory = sanitizeCategory(updatedCategory);
        
        res.json(safeCategory);
    } catch (error) {
        console.error('Ошибка обновления категории:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление категории (только для мастеров)
router.delete('/:id', authenticateToken, requireMaster, (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        
        // Валидация ID
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
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