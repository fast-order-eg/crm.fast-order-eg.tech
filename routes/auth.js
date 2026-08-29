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

            // Handle Remember Me
            console.log("Remember Me Checkbox:", req.body.remember_me);
            if (req.body.remember_me) {
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
                console.log("Session set to persist for 30 days.");
            } else {
                req.session.cookie.expires = false;
                console.log("Session set to expire on browser close.");
            }
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
