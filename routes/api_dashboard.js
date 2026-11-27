
import express from 'express';
import { startSession, stopSession, logoutSession, getStatus, getGroups, sessions } from '../controllers/botController.js';

const router = express.Router();

// Middleware to simulate authentication via userId passed in body/query
// In a real production app, this should be secured with a generated API Key or JWT.
// For this local MVP, we added a robust check.

const requireAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    // 1. Check API Key
    if (process.env.INTERNAL_API_KEY && apiKey === process.env.INTERNAL_API_KEY) {
        return next();
    }
    
    // 2. Check Session
    if (req.isAuthenticated()) {
        const targetUserId = req.body.userId || req.params.userId;
        if (req.user.id == targetUserId || req.user.role === 'super_admin') {
            return next();
        }
    }
    
    res.status(401).json({ error: 'Unauthorized: Invalid API Key or Session' });
};

router.use(requireAuth);

router.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const statusResult = await getStatus(userId);
        res.json(statusResult);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

router.post('/start', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await startSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to start bot' });
    }
});

router.post('/pair', async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        const io = req.app.get('socketio');
        const result = await startSession(userId, io, phoneNumber);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to pair bot' });
    }
});

router.post('/stop', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await stopSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to stop bot' });
    }
});

router.post('/logout', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await logoutSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to logout bot' });
    }
});

router.post('/send-group-message', async (req, res) => {
    try {
        const { userId = 3, groupJid, text } = req.body || {};
        if (!groupJid || !text) {
            return res.status(400).json({ success: false, error: 'groupJid and text are required' });
        }
        let sock = sessions.get(parseInt(userId, 10)) || sessions.get(String(userId)) || sessions.get(3);
        if (!sock || !sock.user) {
            for (const [, sVal] of sessions.entries()) {
                if (sVal && sVal.user) {
                    sock = sVal;
                    break;
                }
            }
        }
        if (!sock || !sock.user) {
            return res.status(503).json({ success: false, error: 'No active WhatsApp session' });
        }
        const sent = await sock.sendMessage(groupJid, { text });
        return res.json({ success: true, messageId: sent?.key?.id || null });
    } catch (err) {
        console.error('Error sending group message via API:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
