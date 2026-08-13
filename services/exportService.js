import XLSX from 'xlsx';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import FinancialTransaction from '../models/FinancialTransaction.js';

/**
 * ترجمة الحالات للغة العربية لعرضها في ملف الإكسيل
 */
function translateStatus(status) {
    const translations = {
        'new': 'جديد',
        'in_funnel': 'داخل الفانل',
        'awaiting_payment': 'في انتظار الدفع',
        'awaiting_sales': 'في انتظار المبيعات',
        'first_follow_up': 'المتابعة الأولى',
        'final_follow_up': 'المتابعة النهائية',
        'scheduled_follow_up': 'متابعة بتاريخ مجدول',
        'successful': 'تم بنجاح (طالب)',
        'not_interested': 'غير مهتم'
    };
    return translations[status] || status;
}

/**
 * توليد ملف Excel يحتوي على بيانات العملاء المفلترة
 */
export async function exportCustomersToExcel(filters) {
    try {
        const customers = await Customer.findAll({
            where: filters,
            include: [
                {
                    model: User,
                    as: 'assignedTo',
                    attributes: ['fullName']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        // تحويل البيانات لصفوف مناسبة للإكسيل
        const rows = customers.map((cust, index) => ({
            'الترقيم': index + 1,
            'اسم العميل': cust.customerName || 'عميل واتساب',
            'رقم الهاتف': cust.phoneNumber,
            'الحالة': translateStatus(cust.status),
            'الموظف المسؤول': cust.assignedTo ? cust.assignedTo.fullName : 'غير مخصص',
            'بداية التواصل': cust.firstContactAt ? new Date(cust.firstContactAt).toLocaleDateString('en-US') : '—',
            'آخر رد من العميل': cust.lastReplyAt ? new Date(cust.lastReplyAt).toLocaleDateString('en-US') : '—',
            'الملاحظات': cust.notes || '—',
            'ملخص AI': cust.aiSummary || '—'
        }));

        // إنشاء ورقة العمل
        const worksheet = XLSX.utils.json_to_sheet(rows);

        // تنسيق اتجاه النص RTL
        worksheet['!views'] = [{ RTL: true }];

        // تعيين حجم الأعمدة تلقائياً لتحسين المظهر
        worksheet['!cols'] = [
            { wch: 8 },  // الترقيم
            { wch: 20 }, // الاسم
            { wch: 16 }, // الهاتف
            { wch: 18 }, // الحالة
            { wch: 20 }, // المسؤول
            { wch: 15 }, // بداية التواصل
            { wch: 15 }, // آخر رد
            { wch: 30 }, // الملاحظات
            { wch: 50 }  // الملخص
        ];

        // إنشاء كتاب العمل وكتابة البيانات للـ buffer
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'العملاء');

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        return buffer;
    } catch (err) {
        console.error('Error generating Excel file:', err);
        throw err;
    }
}

/**
 * توليد ملف Excel يحتوي على إحصائيات الأداء (KPI) للموظفين
 */
export async function exportKPIToExcel(kpis, dateRangeArabic) {
    try {
        const rows = kpis.map((kpi, index) => ({
            'الترقيم': index + 1,
            'الفترة الزمنية': dateRangeArabic || '—',
            'اسم الموظف': kpi.fullName,
            'اسم المستخدم': kpi.username,
            'الدور': kpi.role === 'admin' ? 'مدير' : 'مبيعات',
            'العملاء المستلمين': kpi.customersReceived,
            'العملاء المتواصل معهم': kpi.customersContacted,
            'العقود المنفذة': kpi.contractsClosed,
            'نسبة التحويل (%)': kpi.conversionRate + '%',
            'متوسط سرعة الرد (دقائق)': kpi.avgResponseTimeMin,
            'أسرع رد (دقائق)': kpi.fastestResponseMs !== null ? kpi.fastestResponseMs : '—',
            'أبطأ رد (دقائق)': kpi.slowestResponseMs !== null ? kpi.slowestResponseMs : '—',
            'الردود المتأخرة': kpi.lateResponses,
            'تحديثات الحالة': kpi.statusUpdates,
            'الإيرادات المحققة': Math.round(kpi.revenue || 0)
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet['!views'] = [{ RTL: true }];

        worksheet['!cols'] = [
            { wch: 8 },  // الترقيم
            { wch: 25 }, // الفترة الزمنية
            { wch: 25 }, // اسم الموظف
            { wch: 15 }, // اسم المستخدم
            { wch: 12 }, // الدور
            { wch: 18 }, // العملاء المستلمين
            { wch: 22 }, // العملاء المتواصل معهم
            { wch: 18 }, // العقود المنفذة
            { wch: 18 }, // نسبة التحويل
            { wch: 22 }, // متوسط سرعة الرد
            { wch: 18 }, // أسرع رد
            { wch: 18 }, // أبطأ رد
            { wch: 18 }, // الردود المتأخرة
            { wch: 18 }, // تحديثات الحالة
            { wch: 20 }  // الإيرادات المحققة
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'تقييم الأداء KPI');

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        return buffer;
    } catch (err) {
        console.error('Error generating KPI Excel file:', err);
        throw err;
    }
}

/**
 * توليد ملف Excel يحتوي على العمليات المالية المفلترة
 */
export async function exportFinancialTransactionsToExcel(transactions) {
    try {
        const rows = transactions.map((t, index) => ({
            'الترقيم': index + 1,
            'التاريخ': t.transactionDate,
            'النوع': t.type === 'income' ? 'إيراد' : 'مصروف',
            'المبلغ': parseFloat(t.amount) || 0,
            'العملة': t.currency || 'EGP',
            'الفئة': t.category || 'أخرى',
            'الوصف': t.description || '—',
            'الرقم المرجعي': t.reference || '—',
            'العميل المرتبط': t.customer ? (t.customer.customerName || t.customer.phoneNumber) : '—',
            'مسجل بواسطة': t.recorder ? (t.recorder.fullName || t.recorder.username) : '—'
        }));

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet['!views'] = [{ RTL: true }];

        worksheet['!cols'] = [
            { wch: 8 },  // الترقيم
            { wch: 15 }, // التاريخ
            { wch: 12 }, // النوع
            { wch: 15 }, // المبلغ
            { wch: 10 }, // العملة
            { wch: 18 }, // الفئة
            { wch: 30 }, // الوصف
            { wch: 18 }, // الرقم المرجعي
            { wch: 25 }, // العميل المرتبط
            { wch: 20 }  // مسجل بواسطة
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'العمليات المالية');

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        return buffer;
    } catch (err) {
        console.error('Error generating Financial Excel file:', err);
        throw err;
    }
}

/**
 * توليد ملف Excel يحتوي على تفاصيل مستلمي الحملة
 */
export async function exportCampaignRecipientsToExcel(recipients, campaignName) {
    try {
        const rows = recipients.map((r, index) => {
            let statusText = 'تم الإرسال';
            if (r.replied) {
                statusText = 'تم الرد';
            } else if (r.status === 'read') {
                statusText = 'تمت القراءة';
            } else if (r.status === 'delivered') {
                statusText = 'تم التوصيل';
            }

            return {
                'الترقيم': index + 1,
                'اسم العميل': r.name || 'عميل غير مسجل',
                'رقم الهاتف': r.phone || '—',
                'الحالة': statusText,
                'تاريخ ووقت الإرسال': r.sentAt ? new Date(r.sentAt).toLocaleString('en-US', { hour12: true }) : '—'
            };
        });

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet['!views'] = [{ RTL: true }];

        worksheet['!cols'] = [
            { wch: 8 },  // الترقيم
            { wch: 25 }, // اسم العميل
            { wch: 18 }, // رقم الهاتف
            { wch: 15 }, // الحالة
            { wch: 25 }  // تاريخ الإرسال
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'تفاصيل المستلمين');

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        return buffer;
    } catch (err) {
        console.error('Error generating Campaign Recipients Excel file:', err);
        throw err;
    }
}

