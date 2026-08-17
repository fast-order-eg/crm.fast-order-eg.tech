import express from 'express';
import { verifyWebhook, handleWebhook, getMetaMedia } from '../controllers/metaCloudController.js';

const router = express.Router();

// Meta WhatsApp Webhook endpoints
router.get('/api/whatsapp/meta-webhook', verifyWebhook);
router.post('/api/whatsapp/meta-webhook', handleWebhook);
router.get('/api/whatsapp/meta-media/:mediaId', getMetaMedia);

export default router;
