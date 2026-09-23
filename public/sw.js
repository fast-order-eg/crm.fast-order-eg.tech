// ==========================================
// 🔔 Bird CRM - Web Push Service Worker
// ==========================================

self.addEventListener('install', (event) => {
    // تفعيل Service Worker فوراً دون انتظار إغلاق التابات السابقة
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // السيطرة على كل التابات المفتوحة فوراً
    event.waitUntil(self.clients.claim());
});

// الاستماع لإشعارات الويب بوش الواردة من السيرفر (حتى والمتصفح مغلق تماماً)
self.addEventListener('push', (event) => {
    let payload = {};

    if (event.data) {
        try {
            payload = event.data.json();
        } catch (e) {
            payload = {
                title: 'إشعار جديد - Bird CRM',
                body: event.data.text()
            };
        }
    }

    const title = payload.title || '🔔 عميل جديد - Bird CRM';
    const options = {
        body: payload.body || 'تم تعيين عميل جديد لك في نظام المبيعات.',
        icon: payload.icon || '/bird_crm_logo.png',
        badge: payload.badge || '/bird_crm_logo.png',
        tag: payload.tag || ('crm-push-' + Date.now()),
        renotify: payload.renotify !== undefined ? payload.renotify : true,
        requireInteraction: payload.requireInteraction !== undefined ? payload.requireInteraction : true,
        vibrate: payload.vibrate || [200, 100, 200, 100, 200],
        data: payload.data || {
            url: '/dashboard/notifications'
        },
        actions: [
            {
                action: 'open_chat',
                title: '💬 فتح المحادثة'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// التعامل مع نقر الموظف على الإشعار
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = (event.notification.data && event.notification.data.url) 
        ? event.notification.data.url 
        : '/dashboard/notifications';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // البحث عن تاب مفتوح للداشبورد للتركيز عليه
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if ('focus' in client) {
                    if (client.url.includes(targetUrl) || client.url.includes('/dashboard')) {
                        client.navigate(targetUrl);
                        return client.focus();
                    }
                }
            }
            // إذا لم يكن أي تاب مفتوح (أو المتصفح كان مغلق)، نفتح نافذة جديدة مباشرة
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
