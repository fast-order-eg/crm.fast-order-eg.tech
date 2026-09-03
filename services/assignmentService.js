import { Op } from 'sequelize';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import ChangeLog from '../models/ChangeLog.js';
import { getSetting, setSetting } from './settingsService.js';

/**
 * التحقق مما إذا كان الموظف نشطاً حالياً (ليس في إجازة وضمن ساعات وأيام عمله).
 */
/**
 * الحصول على الوقت واليوم المحلي بتوقيت مصر (Africa/Cairo) بصرامة 100% بغض النظر عن توقيت السيرفر UTC
 */
export function getEgyptTimeInfo() {
    const options = { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const dateObj = {};
    parts.forEach(p => { dateObj[p.type] = p.value; });

    const cairoDateStr = `${dateObj.year}-${dateObj.month}-${dateObj.day}T${dateObj.hour}:${dateObj.minute}:${dateObj.second}`;
    const cairoDate = new Date(cairoDateStr);

    const currentHour = parseInt(dateObj.hour, 10);
    const currentMinute = parseInt(dateObj.minute, 10);
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
    
    const daysOfWeek = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const currentDayArabic = daysOfWeek[cairoDate.getDay()];

    return {
        currentHour,
        currentMinute,
        currentTimeStr,
        currentDayArabic,
        cairoDate
    };
}

/**
 * التحقق مما إذا كان الموظف نشطاً حالياً (ليس في إجازة وضمن ساعات وأيام عمله).
 */
export function isEmployeeActiveNow(employee) {
    if (!employee || employee.isOnLeave || !employee.is_active) return false;

    const { currentTimeStr, currentDayArabic } = getEgyptTimeInfo();
    
    // 1. تحقق من أيام العمل
    if (employee.workDays) {
        const allowedDays = employee.workDays.split(',').map(d => d.trim());
        if (!allowedDays.includes(currentDayArabic)) {
            return false;
        }
    }

    // 2. تحقق من ساعات العمل
    const startTime = employee.workStartTime || '09:00';
    const endTime = employee.workEndTime || '17:00';

    if (startTime <= endTime) {
        return currentTimeStr >= startTime && currentTimeStr <= endTime;
    } else {
        return currentTimeStr >= startTime || currentTimeStr <= endTime;
    }
}

/**
 * تخصيص العميل تلقائياً لموظف مبيعات نشط (Round Robin) بناءً على الأقل عملاء.
 */
export async function assignCustomerToSales(customerId, botOwnerId, io = null, skipNotification = false, preserveStatus = false) {
    try {
        const customer = await Customer.findByPk(customerId);
        if (!customer) {
            console.error(`[Assignment] Customer with ID ${customerId} not found.`);
            return null;
        }

        // 1. Check Lead Routing Rules (Peak Round-Robin & Off-Peak Default Rep)
        let shiftRule = null;
        try {
            shiftRule = await getSetting('shift_split_rule', botOwnerId);
        } catch (e) { console.error('Error getting lead routing rule', e); }

        let selectedEmp = null;
        let usedShiftSplit = false;

        if (shiftRule && shiftRule.enabled) {
            const { currentTimeStr, currentDayArabic: currentDay } = getEgyptTimeInfo();

            let inShiftDays = (!shiftRule.days || shiftRule.days.length === 0 || shiftRule.days.includes(currentDay));
            let inShiftTime = false;
            
            if (shiftRule.startTime && shiftRule.endTime) {
                if (shiftRule.startTime <= shiftRule.endTime) {
                    inShiftTime = currentTimeStr >= shiftRule.startTime && currentTimeStr <= shiftRule.endTime;
                } else {
                    inShiftTime = currentTimeStr >= shiftRule.startTime || currentTimeStr <= shiftRule.endTime;
                }
            }

            if (inShiftDays && inShiftTime && shiftRule.employees && shiftRule.employees.length > 0) {
                // Peak Shift: Round Robin between specified employees (e.g., Rahma & Ola)
                const shiftEmployees = await User.findAll({
                    where: { id: { [Op.in]: shiftRule.employees }, is_active: true }
                });

                if (shiftEmployees.length > 0) {
                    let lastIndex = 0;
                    try {
                        const idx = await getSetting('last_assigned_shift_index', botOwnerId);
                        if (idx !== undefined && idx !== null) lastIndex = parseInt(idx, 10);
                    } catch(e) {}

                    let nextIndex = lastIndex + 1;
                    if (nextIndex >= shiftEmployees.length) nextIndex = 0;

                    selectedEmp = shiftEmployees[nextIndex];
                    await setSetting('last_assigned_shift_index', nextIndex, botOwnerId);
                    usedShiftSplit = true;
                    console.log(`🎯 [LeadRouting] Peak Shift Active (Cairo Time: ${currentTimeStr}). Assigned to ${selectedEmp.fullName || selectedEmp.username} via Round-Robin (Index: ${nextIndex})`);
                }
            } else if (shiftRule.defaultEmployeeId) {
                // Off-Peak Hours / Friday: Direct 100% assignment to default employee (e.g., Rahma)
                const defaultEmp = await User.findOne({
                    where: { id: shiftRule.defaultEmployeeId, is_active: true }
                });
                if (defaultEmp) {
                    selectedEmp = defaultEmp;
                    usedShiftSplit = true;
                    console.log(`🎯 [LeadRouting] Off-Peak Hours Active (Cairo Time: ${currentTimeStr} ${currentDay}). Assigned 100% to Default Rep: ${defaultEmp.fullName || defaultEmp.username}`);
                }
            }
        }

        let candidates = [];
        // 2. Normal Assignment Logic if Shift Split wasn't used
        if (!usedShiftSplit) {
            const salesEmployees = await User.findAll({
                where: { role: 'sales', is_active: true }
            });

            if (salesEmployees.length === 0) {
                console.log(`⚠️ [Assignment] No sales employees found in the system for customer ID: ${customerId}`);
                return null;
            }

            let targetEmployees = salesEmployees.filter(isEmployeeActiveNow);
            let isFallback = false;

            if (targetEmployees.length === 0) {
                console.log(`⚠️ [Assignment] No active on-duty sales employees found. Falling back to random assignment.`);
                targetEmployees = salesEmployees;
                isFallback = true;
            }

            for (const emp of targetEmployees) {
                const activeCount = await Customer.count({
                    where: {
                        assignedToUserId: emp.id,
                        status: { [Op.notIn]: ['successful', 'not_interested'] }
                    }
                });
                candidates.push({ employee: emp, activeCount });
            }

            if (isFallback) {
                const randomIndex = Math.floor(Math.random() * candidates.length);
                selectedEmp = candidates[randomIndex].employee;
            } else {
                candidates.sort((a, b) => a.activeCount - b.activeCount);
                selectedEmp = candidates[0].employee;
            }
        }

        // 6. تخصيص العميل
        customer.assignedToUserId = selectedEmp.id;
        customer.assignedAt = new Date();
        if (!preserveStatus) {
            customer.status = 'awaiting_sales'; // تحويل لحالة انتظار المبيعات فقط لو لم يتم الحفاظ على الحالة
        }
        await customer.save();

        // 7. تسجيل الإجراء في السجل
        try {
            await ChangeLog.create({
                action: 'customer_assigned',
                description: `قام البوت آلياً بتعيين العميل للموظف ${selectedEmp.fullName || selectedEmp.username}`,
                CustomerId: customer.id,
                UserId: botOwnerId
            });
        } catch (logErr) {
            console.error('Error creating ChangeLog for auto-assignment:', logErr);
        }

        // تسجيل إحصائيات التعيين في نظام الـ KPI تلقائياً
        try {
            const { recordAssignment } = await import('./kpiService.js');
            await recordAssignment(selectedEmp.id, customer.id);
        } catch (kpiErr) {
            console.error('Error recording KPI assignment in assignmentService:', kpiErr);
        }

        // إطلاق إشعار للموظف المسؤول عبر لوحة التحكم
        try {
            const { createNotification } = await import('./notificationService.js');
            await createNotification({
                type: 'customer_assigned',
                title: 'عميل جديد (توزيع تلقائي)',
                message: `تم تخصيص عميل جديد لك تلقائياً: "${customer.customerName || customer.phoneNumber}"`,
                targetUserId: selectedEmp.id,
                customerId: customer.id,
                ownerId: botOwnerId,
                io
            });
        } catch (notifErr) {
            console.error('Error creating notification in auto-assignment:', notifErr);
        }

        // إرسال إشعار لجروب الواتساب الخاص بالعمل
        if (!skipNotification) {
            try {
                const whatsappMsg = `📢 *تم تعيين عميل جديد تلقائياً!*\n\n🔖 كود العميل: ${customer.customerNumber || customer.id}\n👤 العميل: ${customer.customerName || 'عميل واتساب'}\n📞 الرقم: ${customer.phoneNumber}\n👨‍💼 الموظف المسؤول: ${selectedEmp.fullName || selectedEmp.username}\n🕐 وقت التعيين: ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: true })}`;
                const { sendWhatsAppNotification } = await import('./notificationService.js');
                await sendWhatsAppNotification(botOwnerId, whatsappMsg);
            } catch (wsErr) {
                console.error('Error sending WhatsApp notification in auto-assignment:', wsErr);
            }
        }

        console.log(`✅ [Assignment] Customer ${customer.customerName || customer.phoneNumber} assigned to ${selectedEmp.fullName} (Active customers count: ${typeof candidates !== "undefined" && candidates.length > 0 ? candidates[0].activeCount : "N/A (Shift Split)"})`);
        return selectedEmp;
    } catch (err) {
        console.error('Error in assignCustomerToSales service:', err);
        return null;
    }
}

/**
 * نقل عملاء موظف عند تفعيل إجازته للموظف البديل أو إعادة توزيعهم.
 */
export async function reassignOnLeave(userId) {
    try {
        const employee = await User.findByPk(userId);
        if (!employee) return;

        // جلب كل العملاء النشطين المخصصين للموظف الذي سيذهب لإجازة
        const activeCustomers = await Customer.findAll({
            where: {
                assignedToUserId: userId,
                status: {
                    [Op.notIn]: ['successful', 'not_interested']
                }
            }
        });

        if (activeCustomers.length === 0) return;

        console.log(`🔄 [Reassignment] Reassigning ${activeCustomers.length} active customers from ${employee.fullName}...`);

        // التحقق من وجود بديل ونشاطه
        let substitute = null;
        if (employee.substituteUserId) {
            const sub = await User.findByPk(employee.substituteUserId);
            if (sub && isEmployeeActiveNow(sub)) {
                substitute = sub;
            }
        }

        if (substitute) {
            // تخصيص كل عملاء الموظف للبديل
            for (const cust of activeCustomers) {
                cust.assignedToUserId = substitute.id;
                cust.assignedAt = new Date();
                await cust.save();
            }
            console.log(`✅ [Reassignment] Reassigned all ${activeCustomers.length} customers to substitute: ${substitute.fullName}`);
        } else {
            // في حالة عدم توفر بديل نشط، نعيد توزيع العملاء باستخدام Round Robin للآخرين
            console.log(`🔍 [Reassignment] No active substitute for ${employee.fullName}. Re-distributing customers...`);
            for (const cust of activeCustomers) {
                // إبعاد الموظف الحالي لضمان عدم إرجاع العميل له
                cust.assignedToUserId = null;
                await cust.save();
                
                const assigned = await assignCustomerToSales(cust.id, cust.UserId);
                if (!assigned) {
                    console.log(`⚠️ [Reassignment] Customer ID ${cust.id} remained unassigned.`);
                }
            }
        }
    } catch (err) {
        console.error('Error in reassignOnLeave service:', err);
    }
}

/**
 * دمج العميل المكرر من Baileys @lid تلقائياً في السجل الرئيسي @s.whatsapp.net
 */
export async function autoMergeDuplicateCustomers(userId, phoneNumber, remoteJid, customerName = null) {
    try {
        if (!userId) return;

        const cleanPhone = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : (remoteJid ? remoteJid.replace(/[^0-9]/g, '') : '');
        
        let primaryCustomer = null;

        if (cleanPhone && cleanPhone.length >= 5) {
            primaryCustomer = await Customer.findOne({
                where: {
                    UserId: userId,
                    [Op.or]: [
                        { phoneNumber: cleanPhone },
                        { remoteJid: `${cleanPhone}@s.whatsapp.net` }
                    ]
                }
            });
        }

        if (!primaryCustomer && customerName && customerName !== 'عميل واتساب' && customerName !== 'Unknown') {
            primaryCustomer = await Customer.findOne({
                where: {
                    UserId: userId,
                    customerName: customerName,
                    remoteJid: { [Op.like]: '%@s.whatsapp.net' }
                }
            });
        }

        if (!primaryCustomer) return;

        const MessageModule = await import('../models/Message.js');
        const Message = MessageModule.default;
        const ConversationModule = await import('../models/Conversation.js');
        const Conversation = ConversationModule.default;

        const duplicateLidCustomers = await Customer.findAll({
            where: {
                UserId: userId,
                id: { [Op.ne]: primaryCustomer.id },
                [Op.or]: [
                    ...(cleanPhone && cleanPhone.length >= 5 ? [{ phoneNumber: cleanPhone }] : []),
                    { remoteJid: { [Op.like]: '%@lid' } }
                ]
            }
        });

        for (const dup of duplicateLidCustomers) {
            const isMatch = (cleanPhone && cleanPhone.length >= 5 && dup.phoneNumber === cleanPhone) ||
                            (customerName && customerName !== 'عميل واتساب' && dup.customerName === customerName);

            if (isMatch && dup.remoteJid && dup.remoteJid.endsWith('@lid')) {
                await Message.update(
                    { remoteJid: primaryCustomer.remoteJid },
                    { where: { UserId: userId, remoteJid: dup.remoteJid } }
                );

                await Conversation.destroy({ where: { UserId: userId, remoteJid: dup.remoteJid } });
                await dup.destroy();
                console.log(`🧹 [AutoMerge] Merged duplicate customer #${dup.customerNumber || dup.id} (${dup.remoteJid}) into primary customer #${primaryCustomer.customerNumber || primaryCustomer.id} (${primaryCustomer.remoteJid})`);
            }
        }
    } catch (err) {
        console.error('Error in autoMergeDuplicateCustomers:', err.message);
    }
}
