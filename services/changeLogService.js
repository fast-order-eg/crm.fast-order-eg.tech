import ChangeLog from '../models/ChangeLog.js';

/**
 * تسجيل إجراء في سجل التغييرات
 * @param {Object} params
 * @param {string} params.action - نوع الإجراء
 * @param {string} params.description - وصف تفصيلي بالعربي
 * @param {string} [params.oldValue] - القيمة القديمة
 * @param {string} [params.newValue] - القيمة الجديدة
 * @param {number} [params.customerId] - معرف العميل المرتبط
 * @param {number} [params.performedByUserId] - معرف الموظف الذي قام بالإجراء
 * @param {number} params.ownerId - معرف صاحب البوت/المدير
 */
export const logChange = async ({ action, description, oldValue, newValue, customerId, performedByUserId, ownerId }) => {
    try {
        const log = await ChangeLog.create({
            action,
            description,
            oldValue: oldValue !== undefined && oldValue !== null ? String(oldValue) : null,
            newValue: newValue !== undefined && newValue !== null ? String(newValue) : null,
            CustomerId: customerId || null,
            performedByUserId: performedByUserId || null,
            UserId: ownerId
        });
        return log;
    } catch (error) {
        console.error('Error in logChange service:', error);
        // لا نريد تعطيل العملية الأساسية إذا فشل التسجيل في السجل
        return null;
    }
};
