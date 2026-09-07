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
    
    // 1. تحقق من أيام العمل (إذا كانت مسجلة)
    if (employee.workDays) {
        const allowedDays = employee.workDays.split(',').map(d => d.trim()).filter(Boolean);
        if (allowedDays.length > 0 && !allowedDays.includes(currentDayArabic)) {
            return false;
        }
    }

    // 2. تحقق من ساعات العمل (إذا كانت مسجلة)
    if (employee.workStartTime && employee.workEndTime) {
        const startTime = employee.workStartTime;
        const endTime = employee.workEndTime;

        if (startTime <= endTime) {
            return currentTimeStr >= startTime && currentTimeStr <= endTime;
        } else {
            return currentTimeStr >= startTime || currentTimeStr <= endTime;
        }
    }

    return true;
}

/**
 * التحقق مما إذا كان الوقت الحالي يقع ضمن فترة الشيفت (مع دعم الفترات العابرة لمنتصف الليل Cross-Midnight).
 */
export function isTimeInShift(currentTime, startTime, endTime) {
    if (!startTime || !endTime) return true;
    if (startTime <= endTime) {
        return currentTime >= startTime && currentTime <= endTime;
    } else {
        // فترة عابرة لمنتصف الليل (مثال: من 23:00 إلى 10:00 صباحاً)
        return currentTime >= startTime || currentTime <= endTime;
    }
}

/**
 * تخصيص العميل تلقائياً لموظف مبيعات نشط (Round Robin) بناءً على الأقل عملاء.
 */
export async function assignCustomerToSales(customerId, botOwnerId, io = null, skipNotification = false, preserveStatus = false, forceReassign = false) {
    try {
        const customer = await Customer.findByPk(customerId);
        if (!customer) {
            console.error(`[Assignment] Customer with ID ${customerId} not found.`);
            return null;
        }

        // 🛡️ قاعدة صارمة: إذا كان العميل معيناً بالفعل لموظف سيلز، لا يتم تغييره آلياً أبداً إلا يدوياً من الداشبورد
        if (customer.assignedToUserId && !forceReassign) {
            console.log(`🔒 [Assignment Guard] Customer ${customerId} is already assigned to User ${customer.assignedToUserId}. Skipping auto reassignment.`);
            const existingRep = await User.findByPk(customer.assignedToUserId);
            return existingRep;
        }

        // 1. Check Lead Routing Rules (Multi-Shift Lead Routing Engine)
        let shiftRule = null;
        try {
            shiftRule = await getSetting('shift_split_rule', botOwnerId);
        } catch (e) { console.error('Error getting lead routing rule', e); }

        let selectedEmp = null;
        let usedShiftSplit = false;

        if (shiftRule && shiftRule.enabled) {
            const { currentTimeStr, currentDayArabic: currentDay } = getEgyptTimeInfo();

            // تجهيز قائمة الشيفتات (سواء بالنظام المتعدد الجديد أو النظام القديم للتوافق)
            let shiftsList = [];
            if (Array.isArray(shiftRule.shifts) && shiftRule.shifts.length > 0) {
                shiftsList = shiftRule.shifts;
            } else if (shiftRule.startTime && shiftRule.endTime) {
                shiftsList = [{
                    id: 'legacy_peak',
                    name: 'فترة الذروة',
                    startTime: shiftRule.startTime,
                    endTime: shiftRule.endTime,
                    days: shiftRule.days || [],
                    employees: shiftRule.employees || []
                }];
            }

            // فحص كل شيفت لمعرفة الشيفت النشط حالياً
            for (let i = 0; i < shiftsList.length; i++) {
                const shift = shiftsList[i];
                const shiftDays = shift.days || [];
                const inShiftDays = (shiftDays.length === 0 || shiftDays.includes(currentDay));
                const inShiftTime = isTimeInShift(currentTimeStr, shift.startTime, shift.endTime);

                if (inShiftDays && inShiftTime && shift.employees && shift.employees.length > 0) {
                    const shiftEmployees = await User.findAll({
                        where: { id: { [Op.in]: shift.employees }, is_active: true }
                    });

                    // استبعاد الموظفين اللي في إجازة لو متوفر غيرهم
                    const availableEmps = shiftEmployees.filter(e => !e.isOnLeave);
                    const pool = availableEmps.length > 0 ? availableEmps : shiftEmployees;

                    if (pool.length > 0) {
                        const shiftKey = `last_assigned_shift_${shift.id || i}`;
                        let lastIndex = -1;
                        try {
                            const idx = await getSetting(shiftKey, botOwnerId);
                            const parsed = parseInt(idx, 10);
                            if (!isNaN(parsed) && Number.isInteger(parsed) && parsed >= 0) {
                                lastIndex = parsed;
                            }
                        } catch(e) {}

                        let nextIndex = lastIndex + 1;
                        if (isNaN(nextIndex) || nextIndex < 0 || nextIndex >= pool.length) {
                            nextIndex = 0;
                        }

                        selectedEmp = pool[nextIndex] || pool[0];
                        await setSetting(shiftKey, nextIndex, botOwnerId);
                        usedShiftSplit = true;
                        const empName = selectedEmp ? (selectedEmp.fullName || selectedEmp.username) : 'Unknown';
                        console.log(`🎯 [LeadRouting] Active Shift [${shift.name || ('Shift ' + (i+1))}] matched (Cairo Time: ${currentTimeStr} ${currentDay}). Assigned to ${empName} (Pool: ${pool.length}, Index: ${nextIndex})`);
                        break;
                    }
                }
            }

            // إذا لم يتطابق أي شيفت، يتم التوجيه للموظف الافتراضي إن وجد
            if (!usedShiftSplit && shiftRule.defaultEmployeeId) {
                const defaultEmp = await User.findOne({
                    where: { id: shiftRule.defaultEmployeeId, is_active: true }
                });
                if (defaultEmp) {
                    selectedEmp = defaultEmp;
                    usedShiftSplit = true;
                    console.log(`🎯 [LeadRouting] Off-Shift Hours (Cairo Time: ${currentTimeStr} ${currentDay}). Assigned to Default Fallback Rep: ${defaultEmp.fullName || defaultEmp.username}`);
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
        if (!selectedEmp) {
            console.error(`⚠️ [Assignment] No valid employee selected for customer ID: ${customerId}`);
            return null;
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

        // إرسال إشعار لجروب الواتساب الخاص بالعمل - تم إلغاؤه للاكتفاء بإشعار ملخص المحادثة فقط
        // if (!skipNotification) { ... }

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
