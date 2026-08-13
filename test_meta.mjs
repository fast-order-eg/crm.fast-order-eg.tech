import axios from 'axios';
const token = 'EAAGpjUD5m1cBSKIdR2caCfNe5V7hjpXVRlR46wvCS9jMuwo9KkCM8J2E1XPkwvm8lyB9UOLVoQgQ8boZBo5bz7oHvYfFgXVHrdioxeeKQPFNqIcxZA1B8QIqYnIZAyIqaCBsiqSWvQLDFjRC1uDLgVyZCMq6sUZAYcdT6LztHsZCTk2rUi0Xve43mbmuJAOoZBoztZA7IfjXDEL1ZA9igzjgZB2UB5Cu0NrHZBslIzxFMnAd9IkpuF7fiZBnDd7ShxZBZBeBVZAKdoIML0lZCq1wckZAQZAW6nU76gBtVZBKnCAF00p728ZD';

async function testSend(phoneId) {
    console.log('Testing Phone ID:', phoneId);
    try {
        const res = await axios.post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: 'whatsapp',
            to: '201092308465',
            type: 'text',
            text: { body: 'اختبار تجريبي' }
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ SUCCESS for', phoneId, ':', res.data);
    } catch (e) {
        console.error('❌ ERROR for', phoneId, ':', e.response?.data || e.message);
    }
}

async function main() {
    await testSend('1187785914426370');
    await testSend('1296526516868956');
}

main();
