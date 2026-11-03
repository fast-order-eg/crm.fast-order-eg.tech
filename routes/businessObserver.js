import express from 'express';
import { ensureAuthenticated, isAdmin } from '../middleware/permissions.js';
import BusinessObserverMessage from '../models/BusinessObserverMessage.js';
import BusinessObserverEmployee from '../models/BusinessObserverEmployee.js';
import BusinessObserverGroup from '../models/BusinessObserverGroup.js';
import BusinessObserverDailyEvaluation from '../models/BusinessObserverDailyEvaluation.js';
import {
    getObserverStatus,
    startObserverSession,
    disconnectObserverSession,
    getObserverMessages,
    getObserverAnalytics,
    getObserverWhatsAppGroups,
    saveOrUpdateObserverGroup
} from '../services/businessObserverService.js';

const router = express.Router();

// الحماية: الأدمن والمشرفين فقط
router.use(ensureAuthenticated, isAdmin);

/**
 * 1. صفحة الراصد الذكي ومحلل الأعمال الرئيسية
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const status = getObserverStatus(userId);
        const analytics = await getObserverAnalytics(userId);
        const employees = await BusinessObserverEmployee.findAll({
            where: { UserId: userId },
            order: [['createdAt', 'DESC']]
        });
        const groups = await BusinessObserverGroup.findAll({
            where: { UserId: userId },
            order: [['createdAt', 'DESC']]
        });
        const dailyEvaluations = await BusinessObserverDailyEvaluation.findAll({
            where: { UserId: userId },
            order: [['evaluationDate', 'DESC'], ['id', 'DESC']],
            limit: 30
        });

        res.render('business_observer', {
            page: 'business_observer',
            user: req.user,
            status,
            analytics,
            employees,
            groups,
            dailyEvaluations,
            success_msg: req.flash ? req.flash('success_msg') : [],
            error_msg: req.flash ? req.flash('error_msg') : []
        });
    } catch (err) {
        console.error('❌ Error rendering Business Observer page:', err);
        res.status(500).send('حدث خطأ أثناء تحميل صفحة راصد الأعمال');
    }
});

/**
 * 2. جلب حالة الاتصال الحالية
 */
router.get('/status', (req, res) => {
    const status = getObserverStatus(req.user.id);
    res.json({ success: true, ...status });
});

/**
 * 3. طلب كود الربط (Pairing Code)
 */
router.post('/pair', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال رقم الهاتف' });
        }
        const io = req.app.get('io');
        await startObserverSession(req.user.id, phone, io);
        res.json({ success: true, message: 'جاري توليد كود الربط...' });
    } catch (err) {
        console.error('❌ Error requesting observer pairing code:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 4. طلب كود QR
 */
router.post('/qr', async (req, res) => {
    try {
        const io = req.app.get('io');
        await startObserverSession(req.user.id, null, io);
        res.json({ success: true, message: 'جاري تجهيز كود QR...' });
    } catch (err) {
        console.error('❌ Error starting observer QR session:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 5. قطع وفصل الاتصال
 */
router.post('/disconnect', async (req, res) => {
    try {
        const io = req.app.get('io');
        const result = await disconnectObserverSession(req.user.id, io);
        res.json(result);
    } catch (err) {
        console.error('❌ Error disconnecting observer session:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 6. جلب الرسائل المرصودة
 */
router.get('/messages', async (req, res) => {
    try {
        const { page, limit, chatJid, senderPhone, type, search } = req.query;
        const data = await getObserverMessages(req.user.id, { page, limit, chatJid, senderPhone, type, search });
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('❌ Error fetching observer messages:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7. إدارة الموظفين: إضافة موظف
 */
router.post('/employees', async (req, res) => {
    try {
        const { name, phone, role, notes, rating, evaluation, evidence } = req.body;
        if (!name || !phone) {
            return res.status(400).json({ success: false, message: 'الاسم ورقم الهاتف مطلوبان' });
        }

        const employee = await BusinessObserverEmployee.create({
            name: name.trim(),
            phone: phone.trim(),
            role: (role || 'موظف').trim(),
            notes: (notes || '').trim(),
            rating: (rating || '').trim(),
            evaluation: (evaluation || '').trim(),
            evidence: (evidence || '').trim(),
            UserId: req.user.id
        });

        res.json({ success: true, message: 'تمت إضافة الموظف بنجاح', employee });
    } catch (err) {
        console.error('❌ Error adding employee:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7.1 جلب بيانات موظف محدد
 */
router.get('/employees/:id', async (req, res) => {
    try {
        const employee = await BusinessObserverEmployee.findOne({
            where: { id: req.params.id, UserId: req.user.id }
        });
        if (!employee) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }
        res.json({ success: true, employee });
    } catch (err) {
        console.error('❌ Error fetching employee details:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 7.2 تحديث بيانات وتقييم موظف
 */
router.post('/employees/:id/update', async (req, res) => {
    try {
        const { name, phone, role, notes, rating, evaluation, evidence, isActive } = req.body;
        const employee = await BusinessObserverEmployee.findOne({
            where: { id: req.params.id, UserId: req.user.id }
        });

        if (!employee) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }

        if (name !== undefined) employee.name = name.trim();
        if (phone !== undefined) employee.phone = phone.trim();
        if (role !== undefined) employee.role = role.trim();
        if (notes !== undefined) employee.notes = notes.trim();
        if (rating !== undefined) employee.rating = rating.trim();
        if (evaluation !== undefined) employee.evaluation = evaluation.trim();
        if (evidence !== undefined) employee.evidence = evidence.trim();
        if (isActive !== undefined) employee.isActive = Boolean(isActive);

        await employee.save();

        res.json({ success: true, message: 'تم تحديث بيانات وتقييم الموظف بنجاح', employee });
    } catch (err) {
        console.error('❌ Error updating employee:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 8. إدارة الموظفين: حذف موظف
 */
router.post('/employees/:id/delete', async (req, res) => {
    try {
        const deleted = await BusinessObserverEmployee.destroy({
            where: { id: req.params.id, UserId: req.user.id }
        });
        res.json({ success: Boolean(deleted), message: 'تم حذف الموظف بنجاح' });
    } catch (err) {
        console.error('❌ Error deleting employee:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 9. إدارة الجروبات: إضافة أو تحديث وصف جروب
 */
router.post('/groups', async (req, res) => {
    try {
        const { groupJid, groupName, groupDescription } = req.body;
        if (!groupName) {
            return res.status(400).json({ success: false, message: 'اسم الجروب مطلوب' });
        }

        const group = await BusinessObserverGroup.create({
            groupJid: (groupJid || '').trim(),
            groupName: groupName.trim(),
            groupDescription: (groupDescription || '').trim(),
            UserId: req.user.id
        });

        res.json({ success: true, message: 'تمت إضافة الجروب بنجاح', group });
    } catch (err) {
        console.error('❌ Error adding group:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 10. إدارة الجروبات: حذف جروب
 */
router.post('/groups/:id/delete', async (req, res) => {
    try {
        const deleted = await BusinessObserverGroup.destroy({
            where: { id: req.params.id, UserId: req.user.id }
        });
        res.json({ success: Boolean(deleted), message: 'تم حذف الجروب بنجاح' });
    } catch (err) {
        console.error('❌ Error deleting group:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 11. جلب جروبات الواتساب مع دعم البحث والصفحات (10 في 10)
 */
router.get('/whatsapp-groups', async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const search = (req.query.search || '').trim().toLowerCase();

        const allGroups = await getObserverWhatsAppGroups(req.user.id);

        let filtered = allGroups;
        if (search) {
            filtered = allGroups.filter(g =>
                (g.groupName && g.groupName.toLowerCase().includes(search)) ||
                (g.groupDescription && g.groupDescription.toLowerCase().includes(search))
            );
        }

        const total = filtered.length;
        const startIndex = (page - 1) * limit;
        const paginated = filtered.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < total;

        res.json({
            success: true,
            groups: paginated,
            total,
            page,
            limit,
            hasMore
        });
    } catch (err) {
        console.error('❌ Error fetching observer WhatsApp groups:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 12. حفظ أو تحديث تخصص جروب مباشرة
 */
router.post('/groups/save-specialization', async (req, res) => {
    try {
        const { groupJid, groupName, groupDescription } = req.body;
        if (!groupName) {
            return res.status(400).json({ success: false, message: 'اسم الجروب مطلوب' });
        }

        const group = await saveOrUpdateObserverGroup(req.user.id, {
            groupJid,
            groupName,
            groupDescription
        });

        res.json({
            success: true,
            message: 'تم حفظ تخصص الجروب بنجاح',
            group
        });
    } catch (err) {
        console.error('❌ Error saving group specialization:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * 13. إحصائيات سريعة للرصد
 */
router.get('/analytics', async (req, res) => {
    try {
        const data = await getObserverAnalytics(req.user.id);
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('❌ Error fetching observer analytics:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
