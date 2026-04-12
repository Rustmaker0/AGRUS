// server/middleware/auth.js
import jwt from 'jsonwebtoken';
import { Session } from '../database.js';
import dotenv from 'dotenv';

dotenv.config();

// Middleware для проверки JWT токена (поддерживает и cookie, и Bearer)
export function authenticateToken(req, res, next) {
    // Сначала пробуем получить токен из cookie
    let token = req.cookies?.token;
    
    // Если нет в cookie, пробуем из заголовка Authorization
    if (!token) {
        const authHeader = req.headers['authorization'];
        token = authHeader && authHeader.split(' ')[1];
    }
    
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    const now = Date.now();
    const session = Session.findByToken.get(token, now);
    
    if (!session) {
        return res.status(403).json({ error: 'Недействительный или истекший токен' });
    }
    
    // Экранируем данные пользователя для безопасности
    const escapeHtml = (str) => {
        if (!str) return str;
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };
    
    req.user = {
        id: session.userId,
        role: session.role,
        name: escapeHtml(session.name),
        email: escapeHtml(session.email)
    };
    
    next();
}

// Middleware для проверки роли "master"
export function requireMaster(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (req.user.role !== 'master') {
        return res.status(403).json({ error: 'Доступ только для мастеров' });
    }
    
    next();
}

// Middleware для проверки роли "client"
export function requireClient(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (req.user.role !== 'client') {
        return res.status(403).json({ error: 'Доступ только для клиентов' });
    }
    
    next();
}

// Middleware для проверки роли "admin" (если понадобится)
export function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ только для администраторов' });
    }
    
    next();
}

// Опциональная аутентификация (не требует токен, но если есть - добавляет user)
export function optionalAuth(req, res, next) {
    let token = req.cookies?.token;
    
    if (!token) {
        const authHeader = req.headers['authorization'];
        token = authHeader && authHeader.split(' ')[1];
    }
    
    if (token) {
        const now = Date.now();
        const session = Session.findByToken.get(token, now);
        
        if (session) {
            const escapeHtml = (str) => {
                if (!str) return str;
                return str
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            };
            
            req.user = {
                id: session.userId,
                role: session.role,
                name: escapeHtml(session.name),
                email: escapeHtml(session.email)
            };
        }
    }
    
    next();
}