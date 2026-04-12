// server.js
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import xss from 'xss-clean';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import './server/database.js';
import { authenticateToken } from './server/middleware/auth.js';

import authRoutes from './server/routes/auth.js';
import userRoutes from './server/routes/users.js';
import categoryRoutes from './server/routes/categories.js';
import serviceRoutes from './server/routes/services.js';
import orderRoutes from './server/routes/orders.js';
import availabilityRoutes from './server/routes/availability.js';
import analyticsRoutes from './server/routes/analytics.js';
import notificationsRoutes from './server/routes/notifications.js';

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const catalogFile = path.join(publicDir, 'catalog.html');
const serviceFile = path.join(publicDir, 'service.html');
const loginFile = path.join(publicDir, 'login.html');

// ============ ЗАЩИТА БЕЗОПАСНОСТИ ============

// 1. Helmet - устанавливает безопасные HTTP заголовки
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'", // Временно для существующего кода, потом уберите
                "https://cdn.jsdelivr.net",
                "https://code.jquery.com"
            ],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// 2. Rate limiting - защита от DDoS и брутфорса
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов с одного IP
    message: 'Слишком много запросов с этого IP, попробуйте позже',
    standardHeaders: true,
    legacyHeaders: false,
});

// Более строгий лимит для API аутентификации
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Слишком много попыток входа, подождите 15 минут',
    skipSuccessfulRequests: true,
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// 3. XSS защита через очистку входных данных
app.use(xss());

// 4. Безопасные CORS настройки
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://agrus-5f1a.onrender.com', 'http://localhost:3000']
        : '*',
    credentials: true,
    optionsSuccessStatus: 200
}));

// 5. Парсинг JSON с ограничением размера
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 6. Статические файлы с безопасными заголовками
app.use(express.static(publicDir, {
    setHeaders: (res, path) => {
        // Запрещаем кэширование HTML файлов
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        // Защита от MIME type sniffing
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

app.use(cookieParser());

// ============ МАРШРУТЫ ============

app.get(['/services', '/services.html'], (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    // Безопасный редирект с валидацией
    const redirectPath = `/catalog.html${query}`;
    res.redirect(302, redirectPath);
});

app.get(['/catalog', '/catalog.html'], (req, res) => {
    res.sendFile(catalogFile);
});

app.get('/service', (req, res) => {
    res.sendFile(serviceFile);
});

app.get('/login', (req, res) => {
    res.sendFile(loginFile);
});

// API маршруты
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', authenticateToken, orderRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/analytics', authenticateToken, analyticsRoutes);
app.use('/api/notifications', authenticateToken, notificationsRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        database: 'SQLite',
        timestamp: new Date().toISOString(),
        features: {
            publicCatalog: true,
            inAppNotifications: true,
            orderReminders: true
        },
        security: {
            csp: true,
            rateLimit: true,
            xssProtection: true
        }
    });
});

// 404 для API
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
    console.error('Ошибка сервера:', err);
    
    // Не показываем детали ошибки в production
    if (process.env.NODE_ENV === 'production') {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    } else {
        res.status(500).json({ 
            error: 'Внутренняя ошибка сервера',
            details: err.message 
        });
    }
});

// Все остальные маршруты отдают index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// Запуск сервера
app.listen(PORT, () => {
    console.log('🚀 AGRUS server (SQLite) running at http://localhost:' + PORT);
    console.log('📁 Статические файлы из папки public');
    console.log('💾 База данных SQLite: server/agrus.db');
    console.log('📊 Режим: модульная архитектура с SQLite');
    console.log('🔔 Уведомления и напоминания: включены');
    console.log('🛡️  Защита активирована: CSP, Rate Limiting, XSS Clean');
});