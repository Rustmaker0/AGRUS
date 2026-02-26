// server.js
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Подключаем базу данных SQLite
import { db } from './server/database.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для аутентификации (из отдельного файла)
import { authenticateToken } from './server/middleware/auth.js';

// Подключаем маршруты из папки routes
import authRoutes from './server/routes/auth.js';
import userRoutes from './server/routes/users.js';
import categoryRoutes from './server/routes/categories.js';
import serviceRoutes from './server/routes/services.js';
import orderRoutes from './server/routes/orders.js';
import availabilityRoutes from './server/routes/availability.js';
import analyticsRoutes from './server/routes/analytics.js';

// Используем маршруты
app.use('/api/auth', authRoutes);
// Публичные маршруты пользователей (не требуют авторизации)
app.use('/api/users', userRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/orders', authenticateToken, orderRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/analytics', authenticateToken, analyticsRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        ok: true, 
        database: 'SQLite',
        timestamp: new Date().toISOString()
    });
});

// Обработка ошибок
app.use((err, req, res, next) => {
    console.error('Ошибка сервера:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Все неизвестные маршруты отдаем index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log('🚀 AGRUS server (SQLite) running at http://localhost:' + PORT);
    console.log('📁 Статические файлы из папки public');
    console.log('💾 База данных SQLite: server/agrus.db');
    console.log('📊 Режим: модульная архитектура с SQLite');
});