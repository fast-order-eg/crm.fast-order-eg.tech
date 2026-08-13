import { CONFIG } from '../config.js';
import { GoogleAuth } from 'google-auth-library';
import { vertexQueue } from '../services/queueService.js';

async function callVertexAI(prompt) {
    const location = 'us-central1';
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent`;

    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
        }
    };

    try {
        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await vertexQueue.add(async () => {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken.token}`
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Vertex AI Error ${res.status}: ${errText}`);
            }
            return res;
        });

        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (error) {
        console.error("AI Call Failed:", error);
        return null; // Return null on error
    }
}

export async function analyzeAndSegmentText(text) {
    const prompt = `
    Analyze this text and split it into logical segments for a chatbot system.
    Return a valid JSON array of objects. Each object must have:
    - "clientName": A short, descriptive name for the topic (e.g., "Prices", "Contact Info").
    - "content": The distinct section of text regarding that topic (keep original details).
    - "keywords": A comma-separated string of 5-10 specific Arabic keywords relevant to this section for retrieval (e.g., "سعر, تكلفة, اشتراك").
    - "type": "topic" (default) or "global" (ONLY if it's general personality/rules/greeting that must ALWAYS be active).

    Text to Analyze:
    ${text}
    `;

    try {
        const textResponse = await callVertexAI(prompt);
        if (!textResponse) return [{
            clientName: "General Instructions",
            content: text,
            keywords: await generateKeywords(text),
            type: "topic"
        }];

        // Clean markdown code blocks
        const cleanResponse = textResponse.replace(/^```json\s*/, "").replace(/\s*```$/, "");

        return JSON.parse(cleanResponse);
    } catch (error) {
        console.error("Gemini Segmentation Error:", error);
        return [{
            clientName: "General Instructions",
            content: text,
            keywords: await generateKeywords(text),
            type: "topic"
        }];
    }
}

export async function generateKeywords(text) {
    const prompt = `
    Generate up to 50 specific Arabic keywords and key phrases for this text to help a chatbot decide when to use it.
    The keywords should cover all possible related topics, synonyms, and variations of the user's intent.
    Return ONLY a comma-separated string (e.g., "word1, word2, phrase 1, phrase 2").
    Do not return anything else.
    
    Text: ${text.substring(0, 1500)}
    `;

    try {
        const keywords = await callVertexAI(prompt);
        return keywords ? keywords.trim().replace(/^```[^`]*```$/g, '').trim() : null;
    } catch (error) {
        console.error("Gemini Keyword Error:", error);
        return null;
    }
}
