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
        masterId: category.masterId,
        created_at: category.created_at
    };
};

// Вспомогательная функция для валидации имени категории
const isValidCategoryName = (name) => {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return false;
    const safeRegex = /^[а-яА-Яa-zA-Z0-9\s\-.,!?()]+$/u;
    return safeRegex.test(trimmed);
};

// Получение всех категорий (доступно всем)
router.get('/', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT * FROM categories ORDER BY name
        `).all();
        
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
        
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
        const category = db.prepare(`
            SELECT * FROM categories WHERE id = ?
        `).get(categoryId);
        
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
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
        const masterId = req.user.id;  // <-- ДОБАВЛЕНО: получаем ID мастера
        
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        if (!isValidCategoryName(trimmedName)) {
            return res.status(400).json({ 
                error: 'Название категории должно содержать от 2 до 100 символов и только буквы, цифры, пробелы и базовую пунктуацию' 
            });
        }
        
        const safeName = escapeHtml(trimmedName);
        
        // Проверяем, существует ли уже такая категория
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ?
        `).get(safeName);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // СОЗДАЕМ КАТЕГОРИЮ С ПРИВЯЗКОЙ К МАСТЕРУ
        const result = db.prepare(`
            INSERT INTO categories (name, masterId) VALUES (?, ?)
        `).run(safeName, masterId);
        
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
        const masterId = req.user.id;  // <-- ДОБАВЛЕНО: получаем ID мастера
        
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Название категории обязательно' });
        }
        
        const trimmedName = name.trim();
        
        if (!isValidCategoryName(trimmedName)) {
            return res.status(400).json({ 
                error: 'Название категории должно содержать от 2 до 100 символов и только буквы, цифры, пробелы и базовую пунктуацию' 
            });
        }
        
        // Проверяем существование категории
        const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(categoryId);
        
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // ПРОВЕРКА ПРАВ: только свою категорию или если masterId = NULL (старые общие)
        if (category.masterId !== null && category.masterId !== masterId) {
            return res.status(403).json({ error: 'Вы можете редактировать только свои категории' });
        }
        
        const safeName = escapeHtml(trimmedName);
        
        // Проверяем, не занято ли новое имя другой категорией
        const existing = db.prepare(`
            SELECT * FROM categories WHERE name = ? AND id != ?
        `).get(safeName, categoryId);
        
        if (existing) {
            return res.status(400).json({ error: 'Категория с таким названием уже существует' });
        }
        
        // Обновляем категорию
        db.prepare(`UPDATE categories SET name = ? WHERE id = ?`).run(safeName, categoryId);
        
        const updatedCategory = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(categoryId);
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
        const masterId = req.user.id;  // <-- ДОБАВЛЕНО: получаем ID мастера
        
        if (isNaN(categoryId) || categoryId <= 0) {
            return res.status(400).json({ error: 'Неверный идентификатор категории' });
        }
        
        // Проверяем существование категории
        const category = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(categoryId);
        
        if (!category) {
            return res.status(404).json({ error: 'Категория не найдена' });
        }
        
        // ПРОВЕРКА ПРАВ: только свою категорию или если masterId = NULL (старые общие)
        if (category.masterId !== null && category.masterId !== masterId) {
            return res.status(403).json({ error: 'Вы можете удалять только свои категории' });
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
        db.prepare(`DELETE FROM categories WHERE id = ?`).run(categoryId);
        
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