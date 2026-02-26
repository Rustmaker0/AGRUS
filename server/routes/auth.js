// server/routes/auth.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User, Session } from '../database.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Регистрация нового пользователя
router.post('/register', async (req, res) => {
    try {
        const { role, name, email, password } = req.body;
        
        // Валидация
        if (!role || !name || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }
        
        if (role !== 'client' && role !== 'master') {
            return res.status(400).json({ error: 'Роль должна быть client или master' });
        }
        
        // Проверка существующего пользователя
        const existingUser = User.findByEmail.get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
        }
        
        // Создаем соль и хеш пароля
        const passSalt = crypto.randomBytes(16).toString('hex');
        const passHash = crypto
            .createHash('sha512')
            .update(password + passSalt)
            .digest('hex');
        
        // Сохраняем пользователя
        const result = User.create.run(role, name, email, passSalt, passHash);
        const userId = result.lastInsertRowid;
        
        // Создаем JWT токен
        const token = jwt.sign(
            { userId, role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
        
        // Вычисляем время истечения
        const expiresInMs = 7 * 24 * 60 * 60 * 1000;
        const expiresAt = Date.now() + expiresInMs;
        
        // Сохраняем сессию
        Session.create.run(token, userId, expiresAt);
        
        res.status(201).json({
            message: 'Пользователь успешно зарегистрирован',
            token,
            user: {
                id: userId,
                role,
                name,
                email
            }
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Вход в систему
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email и пароль обязательны' });
        }
        
        // Ищем пользователя
        const user = User.findByEmail.get(email);
        if (!user) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        // Проверяем пароль
        const hash = crypto
            .createHash('sha512')
            .update(password + user.passSalt)
            .digest('hex');
        
        if (hash !== user.passHash) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        // Создаем JWT токен
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
        
        const expiresInMs = 7 * 24 * 60 * 60 * 1000;
        const expiresAt = Date.now() + expiresInMs;
        
        // Сохраняем сессию
        Session.create.run(token, user.id, expiresAt);
        
        res.json({
            message: 'Вход выполнен успешно',
            token,
            user: {
                id: user.id,
                role: user.role,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Выход из системы
router.post('/logout', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        
        if (token) {
            Session.deleteByToken.run(token);
        }
        
        res.json({ message: 'Выход выполнен успешно' });
    } catch (error) {
        console.error('Ошибка выхода:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;