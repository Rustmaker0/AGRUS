// server/notification-service.js
import { Notification } from './database.js';
function escapeHtml(str) {
    if (!str) return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const REMINDER_OFFSETS = [
    { minutes: 24 * 60, label: 'за 24 часа' },
    { minutes: 2 * 60, label: 'за 2 часа' }
];

function parsePseudoUtcParts(value) {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/);
    if (!match) return null;

    return {
        year: Number(match[1]),
        monthIndex: Number(match[2]) - 1,
        day: Number(match[3]),
        hours: Number(match[4] || 0),
        minutes: Number(match[5] || 0),
        seconds: Number(match[6] || 0),
        milliseconds: Number(String(match[7] || '0').padEnd(3, '0'))
    };
}

function toComparableTimestamp(value) {
    const parts = parsePseudoUtcParts(value);
    if (!parts) return Number.NaN;

    return Date.UTC(
        parts.year,
        parts.monthIndex,
        parts.day,
        parts.hours,
        parts.minutes,
        parts.seconds,
        parts.milliseconds
    );
}

function formatPseudoUtcDateTime(value) {
    const parts = parsePseudoUtcParts(value);
    if (!parts) return String(value || '');

    const dd = String(parts.day).padStart(2, '0');
    const mm = String(parts.monthIndex + 1).padStart(2, '0');
    const yyyy = String(parts.year);
    const hh = String(parts.hours).padStart(2, '0');
    const min = String(parts.minutes).padStart(2, '0');

    return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

function safeMeta(meta) {
    try {
        return JSON.stringify(meta || {});
    } catch {
        return '{}';
    }
}

function createNotification({ recipientUserId, orderId = null, type, title, message, meta = {}, scheduledFor = null }) {
    Notification.create.run(
        recipientUserId,
        orderId,
        type,
        'in_app',
        escapeHtml(title),    // ← добавить
        escapeHtml(message),  // ← добавить
        safeMeta(meta),
        scheduledFor
    );
}

export function removeOrderReminderNotifications(orderId) {
    Notification.deletePendingRemindersByOrder.run(orderId);
}

export function syncOrderReminderNotifications(order) {
    if (!order?.id) return;

    removeOrderReminderNotifications(order.id);

    if (!['NEW', 'ACCEPTED'].includes(order.status)) {
        return;
    }

    const targetTs = toComparableTimestamp(order.desired_datetime);
    if (!Number.isFinite(targetTs)) {
        return;
    }

    const now = Date.now();
    const whenText = formatPseudoUtcDateTime(order.desired_datetime);

    const recipients = [
        {
            userId: order.clientId,
            title: 'Напоминание о записи',
            message: `Скоро начнётся ваша запись на услугу «${order.serviceTitle}» к мастеру ${order.masterName}: ${whenText}.`
        },
        {
            userId: order.masterId,
            title: 'Напоминание о клиенте',
            message: `Скоро запись клиента ${order.clientName} на услугу «${order.serviceTitle}»: ${whenText}.`
        }
    ];

    for (const reminder of REMINDER_OFFSETS) {
        const scheduledFor = targetTs - reminder.minutes * 60 * 1000;
        if (scheduledFor <= now) continue;

        for (const recipient of recipients) {
            createNotification({
                recipientUserId: recipient.userId,
                orderId: order.id,
                type: 'ORDER_REMINDER',
                title: `${recipient.title} (${reminder.label})`,
                message: recipient.message,
                meta: {
                    orderId: order.id,
                    status: order.status,
                    desired_datetime: order.desired_datetime,
                    remindBeforeMinutes: reminder.minutes
                },
                scheduledFor
            });
        }
    }
}

export function createOrderCreatedNotifications(order) {
    const whenText = formatPseudoUtcDateTime(order.desired_datetime);

    createNotification({
        recipientUserId: order.clientId,
        orderId: order.id,
        type: 'ORDER_CREATED',
        title: 'Заявка создана',
        message: `Вы создали заявку на услугу «${order.serviceTitle}». Дата и время: ${whenText}.`,
        meta: {
            orderId: order.id,
            desired_datetime: order.desired_datetime,
            status: order.status
        }
    });

    createNotification({
        recipientUserId: order.masterId,
        orderId: order.id,
        type: 'ORDER_CREATED',
        title: 'Новая заявка',
        message: `Клиент ${order.clientName} создал заявку на услугу «${order.serviceTitle}» на ${whenText}.`,
        meta: {
            orderId: order.id,
            desired_datetime: order.desired_datetime,
            status: order.status
        }
    });

    syncOrderReminderNotifications(order);
}

export function createOrderStatusNotifications({ order, previousStatus, actorRole, reason = null }) {
    const whenText = formatPseudoUtcDateTime(order.desired_datetime);
    const recipients = [];

    switch (order.status) {
        case 'ACCEPTED':
            recipients.push({
                userId: order.clientId,
                title: 'Заявка принята',
                message: `Мастер ${order.masterName} принял вашу заявку на «${order.serviceTitle}» (${whenText}).`
            });
            recipients.push({
                userId: order.masterId,
                title: 'Вы приняли заявку',
                message: `Заявка клиента ${order.clientName} на «${order.serviceTitle}» переведена в статус «Принят».`
            });
            break;

        case 'REJECTED':
            recipients.push({
                userId: order.clientId,
                title: 'Заявка отклонена',
                message: reason
                    ? `Мастер ${order.masterName} отклонил заявку на «${order.serviceTitle}». Причина: ${reason}.`
                    : `Мастер ${order.masterName} отклонил заявку на «${order.serviceTitle}».`
            });
            recipients.push({
                userId: order.masterId,
                title: 'Вы отклонили заявку',
                message: `Заявка клиента ${order.clientName} на «${order.serviceTitle}» отклонена.`
            });
            break;

        case 'DONE':
            recipients.push({
                userId: order.clientId,
                title: 'Заказ выполнен',
                message: `Мастер ${order.masterName} отметил заявку на «${order.serviceTitle}» как выполненную.`
            });
            recipients.push({
                userId: order.masterId,
                title: 'Заказ завершён',
                message: `Вы завершили заказ клиента ${order.clientName} по услуге «${order.serviceTitle}».`
            });
            break;

        case 'CANCELLED':
            recipients.push({
                userId: order.clientId,
                title: 'Заявка отменена',
                message: actorRole === 'client'
                    ? `Вы отменили заявку на «${order.serviceTitle}».`
                    : `Заявка на «${order.serviceTitle}» отменена.`
            });
            recipients.push({
                userId: order.masterId,
                title: 'Клиент отменил заявку',
                message: `Клиент ${order.clientName} отменил заявку на «${order.serviceTitle}».`
            });
            break;

        default:
            recipients.push({
                userId: order.clientId,
                title: 'Статус заявки обновлён',
                message: `Статус вашей заявки на «${order.serviceTitle}» изменён с ${previousStatus} на ${order.status}.`
            });
            recipients.push({
                userId: order.masterId,
                title: 'Статус заявки обновлён',
                message: `Статус заявки клиента ${order.clientName} изменён с ${previousStatus} на ${order.status}.`
            });
    }

    for (const recipient of recipients) {
        createNotification({
            recipientUserId: recipient.userId,
            orderId: order.id,
            type: 'ORDER_STATUS_CHANGED',
            title: recipient.title,
            message: recipient.message,
            meta: {
                orderId: order.id,
                previousStatus,
                status: order.status,
                desired_datetime: order.desired_datetime,
                reason
            }
        });
    }

    syncOrderReminderNotifications(order);
}

export function createOrderRescheduledNotifications({ order, previousDesiredDatetime, actorRole }) {
    const previousText = formatPseudoUtcDateTime(previousDesiredDatetime);
    const nextText = formatPseudoUtcDateTime(order.desired_datetime);

    createNotification({
        recipientUserId: order.clientId,
        orderId: order.id,
        type: 'ORDER_RESCHEDULED',
        title: 'Время записи изменено',
        message: actorRole === 'client'
            ? `Вы перенесли запись по услуге «${order.serviceTitle}»: было ${previousText}, стало ${nextText}.`
            : `Время вашей записи по услуге «${order.serviceTitle}» изменено: было ${previousText}, стало ${nextText}.`,
        meta: {
            orderId: order.id,
            previousDesiredDatetime,
            desired_datetime: order.desired_datetime,
            status: order.status
        }
    });

    createNotification({
        recipientUserId: order.masterId,
        orderId: order.id,
        type: 'ORDER_RESCHEDULED',
        title: 'Запись клиента перенесена',
        message: `Время заявки клиента ${order.clientName} по услуге «${order.serviceTitle}» изменено: было ${previousText}, стало ${nextText}.`,
        meta: {
            orderId: order.id,
            previousDesiredDatetime,
            desired_datetime: order.desired_datetime,
            status: order.status
        }
    });

    syncOrderReminderNotifications(order);
}
