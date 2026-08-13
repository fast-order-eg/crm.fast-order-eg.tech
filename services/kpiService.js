import KPIRecord from '../models/KPIRecord.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { Op, Sequelize } from 'sequelize';

const LATE_RESPONSE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * دالة مساعدة لتوفير الفترات (اليومي والشهري) للتواريخ الحالية
 */
function getPeriods() {
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const monthStr = todayStr.substring(0, 7); // YYYY-MM
    return [
        { type: 'daily', period: todayStr },
        { type: 'monthly', period: monthStr }
    ];
}

/**
 * تسجيل تعيين عميل لموظف
 */
export async function recordAssignment(employeeId, customerId) {
    try {
        if (!employeeId) return;
        const customer = await Customer.findByPk(customerId);
        if (!customer) return;

        // إعادة ضبط علامة الرد للتعيين الجديد لحساب وقت الاستجابة بدقة
        let funnelData = customer.funnelData || {};
        if (typeof funnelData === 'string') {
            try {
                funnelData = JSON.parse(funnelData);
            } catch (e) {
                funnelData = {};
            }
        }
        funnelData.responseRecorded = false;
        customer.funnelData = funnelData;
        await customer.save();

        const periods = getPeriods();
        for (const p of periods) {
            const [kpi] = await KPIRecord.findOrCreate({
                where: {
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: customer.UserId
                },
                defaults: {
                    messagesReceived: 0,
                    customersReceived: 0,
                    customersContacted: 0,
                    contractsClosed: 0,
                    revenue: 0,
                    statusUpdates: 0,
                    totalResponseTimeMs: 0,
                    responseCount: 0,
                    lateResponses: 0
                }
            });

            await kpi.increment('customersReceived', { by: 1 });
        }
    } catch (err) {
        console.error('Error in recordAssignment KPI:', err);
    }
}

/**
 * تسجيل أول رد من الموظف للعميل وحساب سرعة الاستجابة
 */
export async function recordResponse(employeeId, customerId) {
    try {
        if (!employeeId) return;
        const customer = await Customer.findByPk(customerId);
        if (!customer) return;

        let funnelData = customer.funnelData || {};
        if (typeof funnelData === 'string') {
            try {
                funnelData = JSON.parse(funnelData);
            } catch (e) {
                funnelData = {};
            }
        }
        if (funnelData.responseRecorded) {
            // تم تسجيل الرد الأول مسبقاً لهذا التعيين
            return;
        }

        // تحديد علامة تسجيل الرد الأول
        funnelData.responseRecorded = true;
        customer.funnelData = funnelData;
        await customer.save();

        let responseTimeMs = null;
        if (customer.assignedAt) {
            responseTimeMs = new Date() - new Date(customer.assignedAt);
        }

        const periods = getPeriods();
        for (const p of periods) {
            const kpi = await KPIRecord.findOne({
                where: {
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: customer.UserId
                }
            });

            // لو السجل مش موجود (مثلاً الموظف رد على العميل بدون تعيين مسبق)، هننشئه
            if (!kpi) {
                await KPIRecord.create({
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: customer.UserId,
                    messagesReceived: 0,
                    customersReceived: 0,
                    customersContacted: 1,
                    contractsClosed: 0,
                    revenue: 0,
                    statusUpdates: 0,
                    totalResponseTimeMs: responseTimeMs !== null ? responseTimeMs : 0,
                    responseCount: responseTimeMs !== null ? 1 : 0,
                    fastestResponseMs: responseTimeMs !== null ? responseTimeMs : null,
                    slowestResponseMs: responseTimeMs !== null ? responseTimeMs : null,
                    lateResponses: (responseTimeMs !== null && responseTimeMs > LATE_RESPONSE_THRESHOLD_MS) ? 1 : 0
                });
            } else {
                kpi.customersContacted += 1;
                if (responseTimeMs !== null) {
                    kpi.responseCount += 1;
                    kpi.totalResponseTimeMs = Number(kpi.totalResponseTimeMs) + responseTimeMs;

                    if (kpi.fastestResponseMs === null || responseTimeMs < kpi.fastestResponseMs) {
                        kpi.fastestResponseMs = responseTimeMs;
                    }
                    if (kpi.slowestResponseMs === null || responseTimeMs > kpi.slowestResponseMs) {
                        kpi.slowestResponseMs = responseTimeMs;
                    }

                    if (responseTimeMs > LATE_RESPONSE_THRESHOLD_MS) {
                        kpi.lateResponses += 1;
                    }
                }
                await kpi.save();
            }
        }
    } catch (err) {
        console.error('Error in recordResponse KPI:', err);
    }
}

/**
 * تسجيل رسالة واردة من العميل للموظف المخصص
 */
export async function recordMessageReceived(employeeId, ownerId) {
    try {
        if (!employeeId || !ownerId) return;

        const periods = getPeriods();
        for (const p of periods) {
            const [kpi] = await KPIRecord.findOrCreate({
                where: {
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: ownerId
                },
                defaults: {
                    messagesReceived: 0,
                    customersReceived: 0,
                    customersContacted: 0,
                    contractsClosed: 0,
                    revenue: 0,
                    statusUpdates: 0,
                    totalResponseTimeMs: 0,
                    responseCount: 0,
                    lateResponses: 0
                }
            });

            await kpi.increment('messagesReceived', { by: 1 });
        }
    } catch (err) {
        console.error('Error in recordMessageReceived KPI:', err);
    }
}

/**
 * تسجيل إغلاق عقد / صفقة ناجحة وإضافة الأرباح
 */
export async function recordContractClosed(employeeId, customerId, amount) {
    try {
        if (!employeeId) return;
        const customer = await Customer.findByPk(customerId);
        if (!customer) return;

        const periods = getPeriods();
        for (const p of periods) {
            const [kpi] = await KPIRecord.findOrCreate({
                where: {
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: customer.UserId
                },
                defaults: {
                    messagesReceived: 0,
                    customersReceived: 0,
                    customersContacted: 0,
                    contractsClosed: 0,
                    revenue: 0,
                    statusUpdates: 0,
                    totalResponseTimeMs: 0,
                    responseCount: 0,
                    lateResponses: 0
                }
            });

            kpi.contractsClosed += 1;
            kpi.revenue = parseFloat(kpi.revenue) + parseFloat(amount || 0);
            await kpi.save();
        }
    } catch (err) {
        console.error('Error in recordContractClosed KPI:', err);
    }
}

/**
 * تسجيل قيام الموظف بتحديث حالة العميل
 */
export async function recordStatusUpdate(employeeId, ownerId) {
    try {
        if (!employeeId || !ownerId) return;

        const periods = getPeriods();
        for (const p of periods) {
            const [kpi] = await KPIRecord.findOrCreate({
                where: {
                    employeeUserId: employeeId,
                    period: p.period,
                    periodType: p.type,
                    UserId: ownerId
                },
                defaults: {
                    messagesReceived: 0,
                    customersReceived: 0,
                    customersContacted: 0,
                    contractsClosed: 0,
                    revenue: 0,
                    statusUpdates: 0,
                    totalResponseTimeMs: 0,
                    responseCount: 0,
                    lateResponses: 0
                }
            });

            await kpi.increment('statusUpdates', { by: 1 });
        }
    } catch (err) {
        console.error('Error in recordStatusUpdate KPI:', err);
    }
}

/**
 * جلب بيانات الأداء الكلية للموظفين لفترة معينة (يومي/شهري/مخصص)
 */
export async function getAllEmployeesKPI(ownerId, options = {}) {
    try {
        const { period, periodType, dateFrom, dateTo } = options;

        let whereClause = { UserId: ownerId };

        if (dateFrom || dateTo) {
            whereClause.periodType = 'daily';
            whereClause.period = {};
            if (dateFrom) whereClause.period[Op.gte] = dateFrom;
            if (dateTo) whereClause.period[Op.lte] = dateTo;
        } else if (period) {
            whereClause.period = period;
            if (periodType) whereClause.periodType = periodType;
        } else {
            // افتراضياً: الشهر الحالي
            const thisMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
            whereClause.period = thisMonth;
            whereClause.periodType = 'monthly';
        }

        // جلب جميع الموظفين الفعالين
        const allEmployees = await User.findAll({
            where: {
                role: { [Op.in]: ['admin', 'sales'] },
                is_active: true
            },
            attributes: ['id', 'fullName', 'username', 'role']
        });

        // جلب السجلات وتجميعها لكل موظف
        const records = await KPIRecord.findAll({
            where: whereClause,
            attributes: [
                'employeeUserId',
                [Sequelize.fn('SUM', Sequelize.col('messagesReceived')), 'messagesReceived'],
                [Sequelize.fn('SUM', Sequelize.col('customersReceived')), 'customersReceived'],
                [Sequelize.fn('SUM', Sequelize.col('customersContacted')), 'customersContacted'],
                [Sequelize.fn('SUM', Sequelize.col('contractsClosed')), 'contractsClosed'],
                [Sequelize.fn('SUM', Sequelize.col('revenue')), 'revenue'],
                [Sequelize.fn('SUM', Sequelize.col('statusUpdates')), 'statusUpdates'],
                [Sequelize.fn('SUM', Sequelize.col('totalResponseTimeMs')), 'totalResponseTimeMs'],
                [Sequelize.fn('SUM', Sequelize.col('responseCount')), 'responseCount'],
                [Sequelize.fn('SUM', Sequelize.col('lateResponses')), 'lateResponses'],
                [Sequelize.fn('MIN', Sequelize.col('fastestResponseMs')), 'fastestResponseMs'],
                [Sequelize.fn('MAX', Sequelize.col('slowestResponseMs')), 'slowestResponseMs']
            ],
            group: ['employeeUserId']
        });

        const kpiMap = {};
        records.forEach(rec => {
            const raw = rec.get({ plain: true });
            kpiMap[raw.employeeUserId] = raw;
        });

        // تنسيق وإكمال الحسابات النسبية
        const result = allEmployees.map(emp => {
            const raw = kpiMap[emp.id] || {};
            const customersReceived = parseInt(raw.customersReceived || 0);
            const contractsClosed = parseInt(raw.contractsClosed || 0);
            const responseCount = parseInt(raw.responseCount || 0);
            const totalResponseTimeMs = parseInt(raw.totalResponseTimeMs || 0);

            // حساب متوسط زمن الاستجابة بالدقائق
            const avgResponseTimeMin = responseCount > 0 
                ? parseFloat((totalResponseTimeMs / responseCount / 60000).toFixed(1)) 
                : 0;

            // حساب نسبة التحويل (العملاء الناجحين / العملاء المستلمين)
            const conversionRate = customersReceived > 0 
                ? parseFloat(((contractsClosed / customersReceived) * 100).toFixed(1)) 
                : 0;

            return {
                employeeId: emp.id,
                fullName: emp.fullName || emp.username || 'غير معروف',
                username: emp.username || 'unknown',
                role: emp.role || 'sales',
                messagesReceived: parseInt(raw.messagesReceived || 0),
                customersReceived,
                customersContacted: parseInt(raw.customersContacted || 0),
                contractsClosed,
                revenue: parseFloat(raw.revenue || 0),
                statusUpdates: parseInt(raw.statusUpdates || 0),
                avgResponseTimeMin,
                conversionRate,
                fastestResponseMs: raw.fastestResponseMs ? parseFloat((parseInt(raw.fastestResponseMs) / 60000).toFixed(1)) : null,
                slowestResponseMs: raw.slowestResponseMs ? parseFloat((parseInt(raw.slowestResponseMs) / 60000).toFixed(1)) : null,
                lateResponses: parseInt(raw.lateResponses || 0),
                responseCount
            };
        });

        return result;
    } catch (err) {
        console.error('Error in getAllEmployeesKPI service:', err);
        return [];
    }
}
