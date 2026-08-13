// middleware/permissions.js

/**
 * Middleware to ensure the user is authenticated.
 */
export const ensureAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    req.flash('error_msg', 'الرجاء تسجيل الدخول أولاً للوصول إلى هذه الصفحة.');
    res.redirect('/login');
};

/**
 * Middleware to ensure the user has 'super_admin' role.
 */
export const isSuperAdmin = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    if (req.user.role === 'super_admin') {
        return next();
    }
    req.flash('error_msg', 'غير مسموح لك بالوصول. صلاحية مدير النظام (Super Admin) مطلوبة.');
    res.redirect('/dashboard');
};

/**
 * Middleware to ensure the user has 'admin' or 'super_admin' role.
 */
export const isAdmin = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
        return next();
    }
    req.flash('error_msg', 'غير مسموح لك بالوصول. صلاحية الإدارة (Admin) مطلوبة.');
    res.redirect('/dashboard');
};

/**
 * Middleware to ensure the user is 'sales', 'admin', or 'super_admin'.
 */
export const isSales = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    if (req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.role === 'sales') {
        return next();
    }
    req.flash('error_msg', 'غير مسموح لك بالوصول. صلاحية المبيعات (Sales) مطلوبة.');
    res.redirect('/login');
};

/**
 * Middleware to prevent 'sales' role from accessing settings.
 */
export const canAccessSettings = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
        return next();
    }
    req.flash('error_msg', 'عذراً، لا تمتلك الصلاحية الكافية للوصول إلى الإعدادات.');
    res.redirect('/dashboard');
};

/**
 * Middleware to verify if the logged-in sales agent has access to a specific customer.
 * Admins and Super Admins can access any customer.
 */
export const canAccessCustomer = async (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const role = req.user.role;
    if (role === 'super_admin' || role === 'admin') {
        return next();
    }

    const customerId = req.params.id || req.params.customerId || req.body.customerId || req.body.id;
    if (!customerId) {
        req.flash('error_msg', 'معرف العميل غير محدد.');
        return res.redirect('/dashboard/customers');
    }

    try {
        // Dynamic import to prevent app crash when models/Customer.js doesn't exist yet (created in Stage 3)
        const CustomerModule = await import('../models/Customer.js');
        const Customer = CustomerModule.default;

        const customer = await Customer.findByPk(customerId);
        if (!customer) {
            req.flash('error_msg', 'العميل غير موجود.');
            return res.redirect('/dashboard/customers');
        }

        if (customer.assignedToUserId !== req.user.id) {
            req.flash('error_msg', 'غير مسموح لك بالوصول لبيانات هذا العميل.');
            return res.redirect('/dashboard/customers');
        }

        return next();
    } catch (error) {
        console.error('Error in canAccessCustomer middleware:', error);
        
        // Soft fallback for development before Customer model is defined
        if (error.code === 'ERR_MODULE_NOT_FOUND' || error.message.includes('Cannot find module')) {
            console.warn('[Permissions] Customer model is missing. Bypassing check for testing.');
            return next();
        }

        req.flash('error_msg', 'حدث خطأ أثناء التحقق من صلاحية الوصول للعميل.');
        res.redirect('/dashboard/customers');
    }
};

/**
 * Helper function to retrieve all user permissions.
 * Useful for view templates (EJS) to conditionally render UI elements.
 */
export const getUserPermissions = (user) => {
    if (!user) {
        return {
            isSuperAdmin: false,
            isAdmin: false,
            isSales: false,
            canAccessSettings: false,
            canManageEmployees: false,
            canExportData: false
        };
    }

    const role = user.role;
    return {
        isSuperAdmin: role === 'super_admin',
        isAdmin: role === 'super_admin' || role === 'admin',
        isSales: role === 'sales',
        canAccessSettings: role === 'super_admin' || role === 'admin',
        canManageEmployees: role === 'super_admin' || role === 'admin',
        canExportData: role === 'super_admin' || role === 'admin'
    };
};
