import express from 'express';
import passport from 'passport';
const router = express.Router();

router.get('/', (req, res) => {
    res.redirect('/login');
});

router.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

router.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            req.flash('error', info.message);
            return res.redirect('/login');
        }
        req.logIn(user, (err) => {
            if (err) return next(err);

            // Handle Session Persistence (100 Days in RAM via Redis)
            const hundredDaysMs = 100 * 24 * 60 * 60 * 1000;
            req.session.cookie.maxAge = hundredDaysMs;
            console.log("⚡ Session set to persist in Redis RAM for 100 days.");
            if (user.role === 'sales') {
                res.redirect('/dashboard/customers');
            } else {
                res.redirect('/dashboard');
            }
        });
    })(req, res, next);
});

router.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

export default router;
