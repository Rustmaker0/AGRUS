// server/middleware/auth.js
import jwt from 'jsonwebtoken';
import { Session } from '../database.js';
import dotenv from 'dotenv';

dotenv.config();

// Middleware для проверки JWT токена
export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    
    const now = Date.now();
    const session = Session.findByToken.get(token, now);
    
    if (!session) {
        return res.status(403).json({ error: 'Недействительный или истекший токен' });
    }
    
    req.user = {
        id: session.userId,
        role: session.role,
        name: session.name,
        email: session.email
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