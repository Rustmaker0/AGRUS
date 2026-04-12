// server/routes/auth.js
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User, Session } from '../database.js';
import dotenv from 'dotenv';
import escapeHtml from 'escape-html';
import rateLimit from 'express-rate-limit';

dotenv.config();

const router = express.Router();

// Строгий лимит для регистрации
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 10, // максимум 10 регистраций с одного IP
    message: 'Слишком много попыток регистрации, попробуйте позже',
    skipSuccessfulRequests: true
});

// Строгий лимит для логина
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 20, // максимум 20 попыток
    message: 'Слишком много попыток входа, подождите 15 минут',
    skipSuccessfulRequests: true
});

// Вспомогательная функция для безопасной установки cookie
const setSecureCookie = (res, token) => {
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 дней
        path: '/'
    });
};

// Вспомогательная функция для очистки cookie
const clearSecureCookie = (res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/'
    });
};

// Вспомогательная функция для валидации email
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    return emailRegex.test(email);
};

// Вспомогательная функция для санитизации пользовательских данных
const sanitizeUserData = (user) => {
    if (!user) return null;
    return {
        id: user.id,
        role: escapeHtml(String(user.role)),
        name: escapeHtml(String(user.name)),
        email: escapeHtml(String(user.email))
    };
};

// Регистрация нового пользователя
router.post('/register', registerLimiter, async (req, res) => {
    try {
        const role = String(req.body?.role || '').trim().toLowerCase();
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        
        // Валидация всех полей
        if (!role || !name || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны', code: 'VALIDATION_ERROR' });
        }
        
        // Валидация роли
        if (role !== 'client' && role !== 'master') {
            return res.status(400).json({ error: 'Роль должна быть client или master', code: 'INVALID_ROLE' });
        }
        
        // Валидация имени (не только длина, но и содержимое)
        if (name.length < 2 || name.length > 100) {
            return res.status(400).json({ error: 'Имя должно быть от 2 до 100 символов', code: 'INVALID_NAME' });
        }
        
        // Защита от XSS через имя (экранируем HTML символы)
        const safeName = escapeHtml(name);
        
        // Валидация email
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Неверный формат email', code: 'INVALID_EMAIL' });
        }
        
        // Валидация пароля
        if (password.length < 4) {
            return res.status(400).json({ 
                error: 'Пароль слишком короткий. Минимум 4 символа', 
                code: 'PASSWORD_TOO_SHORT', 
                minLength: 4 
            });
        }
        
        if (password.length > 128) {
            return res.status(400).json({ 
                error: 'Пароль слишком длинный. Максимум 128 символов', 
                code: 'PASSWORD_TOO_LONG' 
            });
        }
        
        // Проверка существующего пользователя
        const existingUser = User.findByEmail.get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Почта уже зарегистрирована', code: 'EMAIL_EXISTS' });
        }
        
        // Создаем соль и хеш пароля
        const passSalt = crypto.randomBytes(16).toString('hex');
        const passHash = crypto
            .createHash('sha512')
            .update(password + passSalt)
            .digest('hex');
        
        // Сохраняем пользователя с экранированным именем
        const result = User.create.run(role, safeName, email, passSalt, passHash);
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
        
        // Устанавливаем безопасную cookie
        setSecureCookie(res, token);
        
        // Отправляем ответ (без токена в теле)
        res.status(201).json({
            message: 'Пользователь успешно зарегистрирован',
            user: {
                id: userId,
                role,
                name: safeName,
                email
            }
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Вход в систему
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email и пароль обязательны' });
        }
        
        // Валидация email
        if (!isValidEmail(email)) {
            return res.status(401).json({ error: 'Неверный email или пароль' }); // Не уточняем причину
        }
        
        // Ищем пользователя
        const user = User.findByEmail.get(email);
        if (!user) {
            // Задержка для предотвращения атак по времени
            await new Promise(resolve => setTimeout(resolve, 100));
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        // Проверяем пароль
        const hash = crypto
            .createHash('sha512')
            .update(password + user.passSalt)
            .digest('hex');
        
        if (hash !== user.passHash) {
            await new Promise(resolve => setTimeout(resolve, 100));
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
        
        // Удаляем старые сессии пользователя (опционально)
        Session.deleteByUserId?.run(user.id);
        
        // Сохраняем новую сессию
        Session.create.run(token, user.id, expiresAt);
        
        // Устанавливаем безопасную cookie
        setSecureCookie(res, token);
        
        // Санитизируем данные пользователя перед отправкой
        const safeUser = sanitizeUserData(user);
        
        res.json({
            message: 'Вход выполнен успешно',
            user: safeUser
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Выход из системы
router.post('/logout', async (req, res) => {
    try {
        // Получаем токен из cookie или заголовка
        let token = req.cookies?.token;
        
        if (!token) {
            const authHeader = req.headers['authorization'];
            token = authHeader && authHeader.split(' ')[1];
        }
        
        if (token) {
            // Удаляем сессию из БД
            Session.deleteByToken.run(token);
        }
        
        // Очищаем cookie
        clearSecureCookie(res);
        
        res.json({ message: 'Выход выполнен успешно' });
    } catch (error) {
        console.error('Ошибка выхода:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Проверка токена (для фронтенда)
router.get('/verify', async (req, res) => {
    try {
        let token = req.cookies?.token;
        
        if (!token) {
            const authHeader = req.headers['authorization'];
            token = authHeader && authHeader.split(' ')[1];
        }
        
        if (!token) {
            return res.status(401).json({ authenticated: false });
        }
        
        // Проверяем сессию в БД
        const session = Session.findByToken?.get(token);
        if (!session || session.expiresAt < Date.now()) {
            return res.status(401).json({ authenticated: false });
        }
        
        // Декодируем токен
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Получаем пользователя
        const user = User.findById?.get(decoded.userId);
        if (!user) {
            return res.status(401).json({ authenticated: false });
        }
        
        const safeUser = sanitizeUserData(user);
        
        res.json({
            authenticated: true,
            user: safeUser
        });
    } catch (error) {
        console.error('Ошибка проверки токена:', error);
        res.status(401).json({ authenticated: false });
    }
});

export default router;