const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { PDFParse } = require('pdf-parse');
const { EventEmitter } = require('events');
const cron = require('node-cron');

const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const app = express();
const server = require('http').createServer(app);

// Data Directory fallback to local './data' if not packaged
const dataDir = process.env.XECK_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
console.log(`[Server] Using Data Directory: ${dataDir}`);

// Ensure database file exists
const dbPath = path.join(dataDir, 'contracts.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Error opening database', err.message); return; }
    console.log('Connected to the SQLite database.');

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT DEFAULT 'Other',
            monthly_cost REAL DEFAULT 0,
            billing_cycle TEXT DEFAULT 'Monthly',
            start_date TEXT,
            contract_end_date TEXT,
            permanencia_end_date TEXT,
            notes TEXT,
            file_path TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // --- GOOGLE OAUTH CONFIGURATION ---
        // Credentials are now managed via the application UI (Settings > Account / Storage)
        // and stored securely in the local database. Do not hardcode secrets here.


        // Migrations for existing DBs
        const migrations = [
            `ALTER TABLE contracts ADD COLUMN category TEXT DEFAULT 'Other'`,
            `ALTER TABLE contracts ADD COLUMN billing_cycle TEXT DEFAULT 'Monthly'`,
            `ALTER TABLE contracts ADD COLUMN start_date TEXT`,
            `ALTER TABLE contracts ADD COLUMN contract_end_date TEXT`,
            `ALTER TABLE contracts ADD COLUMN notes TEXT`,
            `ALTER TABLE contracts ADD COLUMN created_at TEXT`,
            `ALTER TABLE contracts ADD COLUMN status TEXT DEFAULT 'active'`
        ];
        migrations.forEach(sql => db.run(sql, () => {}));
    });
});


// Event buses for inter-process communication
const authBus = new EventEmitter();
const updateBus = new EventEmitter();
let updateProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0, status: 'idle' };

// --- CRON JOB: Daily Contract Expiry Check (Noon) ---
cron.schedule('0 12 * * *', () => {
    db.get("SELECT value FROM settings WHERE key = 'xeck_login_mode'", (err, modeRow) => {
        const isLocal = !modeRow || modeRow.value === 'local';
        // If user is in Google mode, we rely on Google Calendar reminders instead of local tray pops
        if (!isLocal) return;

        const today = new Date();
        db.all("SELECT * FROM contracts", [], (err, rows) => {
            if (err || !rows) return;
            rows.forEach(c => {
                if (c.status === 'archived') return;

                let sDate = c.permanencia_end_date || c.contract_end_date;
                if (!sDate) return;
                let parts = sDate.split('/');
                if (parts.length !== 3) return;
                let extDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`);
                if (isNaN(extDate)) return;
                
                const diffTime = extDate - today;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                
                if (diffDays > 0 && diffDays <= 60) {
                    updateBus.emit('show-notification', {
                        title: `Xeck: Renovation Reminder`,
                        body: `Your contract "${c.title}" expires in ${diffDays} days.`
                    });
                }
            });
        });
    });
});


const CATEGORY_I18N = {
    en: {
        cat_utilities: "Services", cat_insurance: "Insurance", cat_mobile: "Mobile",
        cat_subscription: "Subscription", cat_internet: "Internet", cat_other: "Other", cat_docs: "Documentation"
    },
    es: {
        cat_utilities: "Servicios", cat_insurance: "Seguros", cat_mobile: "Móvil",
        cat_subscription: "Suscripción", cat_internet: "Internet", cat_other: "Otro", cat_docs: "Documentación"
    },
    zh: {
        cat_utilities: "水电煤", cat_insurance: "保险", cat_mobile: "通信",
        cat_subscription: "订阅", cat_internet: "宽带", cat_other: "其他", cat_docs: "证件"
    }
};

function getAllPossibleCategoryNames(catKey) {
    const names = new Set();
    Object.values(CATEGORY_I18N).forEach(langMap => {
        if (langMap[catKey]) names.add(langMap[catKey]);
    });
    // Add the key itself without 'cat_' prefix just in case
    names.add(catKey.replace('cat_', '').charAt(0).toUpperCase() + catKey.replace('cat_', '').slice(1));
    return Array.from(names);
}

const port = 3000;

const UPLOADS_DIR = path.join(dataDir, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const CONTRACTS_DIR = path.join(dataDir, 'Contracts');
if (!fs.existsSync(CONTRACTS_DIR)) fs.mkdirSync(CONTRACTS_DIR, { recursive: true });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(dataDir, 'uploads')));
app.use('/Contracts', express.static(path.join(dataDir, 'Contracts')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Server-side state for translations ---
let current_language = 'en';

async function loadServerLanguage() {
    return new Promise((resolve) => {
        db.get("SELECT value FROM settings WHERE key = 'current_language'", (err, row) => {
            if (!err && row) current_language = row.value;
            resolve(current_language);
        });
    });
}

function getTranslatedCategoryName(categoryKey, lang = current_language) {
    const langMap = CATEGORY_I18N[lang] || CATEGORY_I18N['en'];
    // Handle both 'Utilities' and 'cat_utilities' formats
    const key = categoryKey.startsWith('cat_') ? categoryKey : 'cat_' + categoryKey.toLowerCase();
    return langMap[key] || categoryKey;
}

// Multer for contract documents
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Multer for backup import
const importUpload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dataDir),
    filename: (req, file, cb) => cb(null, 'imported_backup.zip')
})});

// Multer for AI analysis (keep in memory, max 20MB per file, max 10 files)
const analyzeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── SETTINGS API ────────────────────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
    db.get("SELECT 1 FROM settings WHERE key = 'google_tokens'", (err, row) => {
        res.json({ authenticated: !!row });
    });
});

app.get('/api/settings', (req, res) => {
    db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const obj = {};
        rows.forEach(r => { 
            // Don't send sensitive tokens or secrets to frontend
            if (r.key === 'google_tokens') {
                obj.has_google_auth = true;
            } else if (r.key === 'google_client_secret') {
                obj.google_client_secret = '********';
            } else {
                obj[r.key] = r.value;
            }
        });
        res.json(obj);
    });
});

app.post('/api/settings', (req, res) => {
    const entries = Object.entries(req.body);
    if (!entries.length) return res.json({ ok: true });
    const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    entries.forEach(([k, v]) => stmt.run(k, v));
    stmt.finalize(() => res.json({ ok: true }));
});

// --- Language Migration API ---
app.post('/api/migrate-language', async (req, res) => {
    const { fromLang, toLang } = req.body;
    if (!toLang) return res.status(400).json({ error: "toLang required" });

    console.log(`[Migration] Language changed to ${toLang}`);
    current_language = toLang;
    db.run("INSERT INTO settings (key, value) VALUES ('current_language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [toLang]);

    if (fromLang === toLang) return res.json({ ok: true });

    try {
        const toMap = CATEGORY_I18N[toLang] || CATEGORY_I18N['en'];

        // 1. Robust local folder migration
        // Instead of relying on fromLang, scan for ANY known translation and rename it to the target
        const catKeys = Object.keys(toMap); // ['cat_utilities', ...]
        for (const catKey of catKeys) {
            const targetName = toMap[catKey];
            const allAlts = getAllPossibleCategoryNames(catKey);
            const targetPath = path.join(CONTRACTS_DIR, targetName);

            for (const alt of allAlts) {
                if (alt === targetName) continue;
                const altPath = path.join(CONTRACTS_DIR, alt);

                if (fs.existsSync(altPath)) {
                    console.log(`[Migration] Consolidating local folder: ${alt} -> ${targetName}`);
                    if (!fs.existsSync(targetPath)) {
                        fs.renameSync(altPath, targetPath);
                    } else {
                        // Merge contents if somehow both exist
                        const subDirs = fs.readdirSync(altPath);
                        for (const d of subDirs) {
                            const oldSub = path.join(altPath, d);
                            const newSub = path.join(targetPath, d);
                            if (fs.existsSync(newSub)) {
                                const files = fs.readdirSync(oldSub);
                                for (const f of files) {
                                    fs.renameSync(path.join(oldSub, f), path.join(newSub, f));
                                }
                                fs.rmdirSync(oldSub);
                            } else {
                                fs.renameSync(oldSub, newSub);
                            }
                        }
                        fs.rmdirSync(altPath);
                    }
                }
            }
        }

        // 2. Update Database paths (Keep keys stable, update file_path to new translated folders)
        db.all("SELECT id, category, file_path FROM contracts", [], (err, rows) => {
            if (err) throw err;

            db.serialize(() => {
                const stmt = db.prepare("UPDATE contracts SET category = ?, file_path = ? WHERE id = ?");
                rows.forEach(row => {
                    // 1. Identify which category key this contract belongs to
                    let catKey = null;
                    for (const lang of Object.keys(CATEGORY_I18N)) {
                        const found = Object.keys(CATEGORY_I18N[lang]).find(k => CATEGORY_I18N[lang][k] === row.category);
                        if (found) { catKey = found; break; }
                    }
                    if (!catKey) {
                        // fallback if not found in maps, check if it matches a key itself
                        catKey = 'cat_' + row.category.toLowerCase();
                        if (!toMap[catKey]) catKey = 'cat_other';
                    }

                    const stableKey = catKey.replace('cat_', '');
                    const capitalizedStableKey = stableKey.charAt(0).toUpperCase() + stableKey.slice(1);
                    const newTranslatedCat = toMap[catKey] || capitalizedStableKey;

                    // 2. Update the file_path in DB if it contains a previously translated category name
                    let newFilePath = row.file_path;
                    if (row.file_path && row.file_path.includes('Contracts/')) {
                        // Robust path update: replace the category segment regardless of what language it was in
                        const parts = row.file_path.split('/');
                        const contractsIdx = parts.indexOf('Contracts');
                        if (contractsIdx !== -1 && parts.length > contractsIdx + 1) {
                            parts[contractsIdx + 1] = newTranslatedCat;
                            newFilePath = parts.join('/');
                        }
                    }

                    stmt.run(capitalizedStableKey, newFilePath, row.id);
                });
                stmt.finalize(() => {
                    console.log(`[Migration] Database update completed.`);
                    res.json({ ok: true });
                });
            });
        });

    } catch (err) {
        console.error("[Migration] Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/list-models', async (req, res) => {
    // ... (existing code omitted for brevity but preserved)
    const { provider, apiKey } = req.query;
    if (!provider || !apiKey) return res.status(400).json({ error: 'Missing provider or apiKey' });

    try {
        if (provider === 'openai' || provider === 'nvidia') {
            const baseUrl = provider === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : 'https://api.openai.com/v1';
            const r = await fetch(`${baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            const data = await r.json();
            if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'API error' });
            
            const models = (data.data || []).map(m => ({
                value: m.id,
                label: m.id.split('/').pop() || m.id
            })).sort((a, b) => a.label.localeCompare(b.label));
            
            return res.json(models);
        } 
        
        if (provider === 'gemini') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const data = await r.json();
            if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Gemini error' });
            
            const models = (data.models || [])
                .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                .map(m => ({
                    value: m.name.replace('models/', ''),
                    label: m.displayName || m.name.split('/').pop()
                })).sort((a, b) => a.label.localeCompare(b.label));
            return res.json(models);
        }

        if (provider === 'claude') {
            return res.json([
                { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
                { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
                { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' }
            ]);
        }

        res.status(400).json({ error: 'Provider not supported for dynamic discovery' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ai-advice', async (req, res) => {
    const { lang } = req.body;
    
    db.all(`SELECT key, value FROM settings`, [], async (err, settingsRows) => {
        if (err) return res.status(500).json({ error: err.message });
        const cfg = {};
        settingsRows.forEach(r => { cfg[r.key] = r.value; });

        const provider = cfg.ai_provider || '';
        const apiKey = cfg.ai_api_key || '';
        const aiModel = cfg.ai_model || '';

        if (!provider || !apiKey) {
            return res.status(400).json({ error: 'AI not configured' });
        }

        db.all(`SELECT * FROM contracts`, [], async (err, contracts) => {
            if (err) return res.status(500).json({ error: err.message });

            const contractsSummary = contracts.map(c => ({
                title: c.title,
                cost: c.monthly_cost,
                billing: c.billing_cycle,
                category: c.category,
                end_date: c.contract_end_date,
                notes: c.notes
            }));

            const advicePrompt = `
You are a senior negotiation specialist and contract consultant for consumers in Spain (or the user's local market).
Analyze the following user contract data:
User contracts: ${JSON.stringify(contractsSummary)}

Please provide:
1. **Financial Audit**: Identify high-expense items and their current lock-in/permanencia status.
2. **Current Market Rates**: Use your knowledge (and live search if enabled) to estimate current competitive market rates for their most expensive service (e.g., Digi, O2, Orange for telcos; current indexed prices for energy).
3. **Negotiation Strategy ("Amago" / Retention dept)**: For the most overpriced/expiring contract, write a detailed, step-by-step Spanish negotiation script that the user can read directly over the phone to their provider's retention department to lower their bill, referencing the competitor's price.
4. **Actionable Summary**: What exact action should the user take today?

IMPORTANT: 
- Provide the response in ${lang === 'zh' ? 'Chinese (except for the Spanish phone script)' : lang === 'es' ? 'Spanish' : 'English (except for the Spanish phone script)'}.
- Be incredibly specific about estimated prices, competitor names, and the exact words to say on the phone.
- Format with Markdown (bolding, lists).
`;

            try {
                let resultText = '';
                if (provider === 'openai') {
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify({
                            model: aiModel || 'gpt-4o',
                            messages: [{ role: 'user', content: advicePrompt }]
                        })
                    });
                    const d = await r.json();
                    resultText = d.choices?.[0]?.message?.content || '';
                } else if (provider === 'gemini') {
                    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            contents: [{ parts: [{ text: advicePrompt }] }],
                            tools: [{ googleSearch: {} }] 
                        })
                    });
                    const d = await r.json();
                    resultText = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
                } else if (provider === 'claude') {
                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model: aiModel || 'claude-3-5-sonnet-20241022',
                            messages: [{ role: 'user', content: advicePrompt }],
                            max_tokens: 2000
                        })
                    });
                    const d = await r.json();
                    resultText = d.content?.[0]?.text || '';
                } else if (provider === 'nvidia') {
                    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify({
                            model: aiModel || 'meta/llama-3.1-8b-instruct',
                            messages: [{ role: 'user', content: advicePrompt }]
                        })
                    });
                    const d = await r.json();
                    resultText = d.choices?.[0]?.message?.content || '';
                }
                res.json({ advice: resultText });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
    });
});

// ─── AI BAJA LETTER GENERATOR ─────────────────────────────────────────────────
app.post('/api/ai-baja', async (req, res) => {
    const { contractId, lang } = req.body;

    db.all(`SELECT key, value FROM settings`, [], async (err, settingsRows) => {
        if (err) return res.status(500).json({ error: err.message });
        const cfg = {};
        settingsRows.forEach(r => { cfg[r.key] = r.value; });

        const provider = cfg.ai_provider || '';
        const apiKey = cfg.ai_api_key || '';
        const aiModel = cfg.ai_model || '';
        const profileName = cfg.profile_name || '';

        if (!provider || !apiKey) {
            return res.status(400).json({ error: 'AI not configured' });
        }

        db.get(`SELECT * FROM contracts WHERE id = ?`, [contractId], async (err, contract) => {
            if (err || !contract) return res.status(404).json({ error: 'Contract not found' });

            // Read contract document if available
            let documentText = '';
            if (contract.file_path) {
                const filePaths = contract.file_path.split(';').filter(p => p.trim());
                for (const fp of filePaths) {
                    try {
                        const absPath = path.join(dataDir, fp.trim());
                        if (fs.existsSync(absPath) && absPath.toLowerCase().endsWith('.pdf')) {
                            const buffer = fs.readFileSync(absPath);
                            const { PDFParse } = require('pdf-parse');
                            const parser = new PDFParse({ data: buffer });
                            const pdfData = await parser.getText();
                            await parser.destroy();
                            documentText += `\n--- ${path.basename(fp)} ---\n${(pdfData.text || '').slice(0, 3000)}\n`;
                        }
                    } catch (e) { /* skip unreadable files */ }
                }
            }

            const outputLang = lang === 'zh' ? 'Chinese (Simplified)' : lang === 'es' ? 'Spanish' : 'English';
            const today = new Date().toLocaleDateString('es-ES');

            const bajaPrompt = `You are a legal document specialist. Generate an official, formal contract cancellation letter ("Carta de Baja" or equivalent) for the following contract.

CONTRACT INFORMATION:
- Title: ${contract.title}
- Category: ${contract.category}
- Monthly Cost: €${contract.monthly_cost}
- Start Date: ${contract.start_date || 'Unknown'}
- Contract End Date: ${contract.contract_end_date || 'Not specified'}
- Lock-in End Date: ${contract.permanencia_end_date || 'None'}
- Notes: ${contract.notes || 'None'}
- Policy/Reference from notes: Look for any policy number, reference, or contract ID in the notes.
${documentText ? `\nCONTRACT DOCUMENT CONTENT (extracted text):\n${documentText}` : ''}

LETTER REQUIREMENTS:
1. Write a fully formal, professional cancellation letter in ${outputLang}.
2. Use the holder name: ${profileName || '[YOUR NAME]'}
3. Today's date: ${today}
4. Include: formal salutation, clear cancellation statement, effective date request, data protection request (GDPR/LOPD), confirmation request.
5. Extract from the document or notes: provider company name, customer reference/policy number, customer service address if found.
6. If the language is Spanish, use formal "usted" form throughout.
7. Output ONLY the letter text, no explanation, no markdown formatting. Start directly with the place and date.`;

            try {
                let letterText = '';
                if (provider === 'openai' || provider === 'nvidia') {
                    const baseUrl = provider === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : 'https://api.openai.com/v1';
                    const r = await fetch(`${baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify({ model: aiModel || 'gpt-4o', messages: [{ role: 'user', content: bajaPrompt }] })
                    });
                    const d = await r.json();
                    letterText = d.choices?.[0]?.message?.content || '';
                } else if (provider === 'gemini') {
                    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: bajaPrompt }] }] })
                    });
                    const d = await r.json();
                    letterText = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
                } else if (provider === 'claude') {
                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                        body: JSON.stringify({ model: aiModel || 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: bajaPrompt }], max_tokens: 1500 })
                    });
                    const d = await r.json();
                    letterText = d.content?.[0]?.text || '';
                }
                res.json({ letter: letterText });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
    });
});

// ─── NOTIFICATION TRIGGER ─────────────────────────────────────
app.post('/api/notify', express.json(), (req, res) => {
    const { title, body } = req.body;
    updateBus.emit('show-notification', { title, body });
    res.json({ success: true });
});

// ─── AI CONTRACT ANALYSIS ────────────────────────────────────────────────────────────
app.post('/api/analyze-contract', analyzeUpload.array('document', 10), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files provided' });

    db.all(`SELECT key, value FROM settings`, [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const cfg = {};
        rows.forEach(r => { cfg[r.key] = r.value; });

        const provider = cfg.ai_provider || '';
        const apiKey = cfg.ai_api_key || '';
        const aiModel = cfg.ai_model || '';

        if (!provider || !apiKey) {
            return res.status(400).json({ error: 'No AI provider configured.' });
        }

        let combinedText = '';
        const visualParts = []; 
        
        for (const file of req.files) {
            const fileBase64 = file.buffer.toString('base64');
            const mimeType = file.mimetype || 'application/pdf';
            const isPdf = mimeType === 'application/pdf' || (file.originalname && file.originalname.toLowerCase().endsWith('.pdf'));
            
            if (isPdf) {
                let parser = null;
                try {
                    parser = new PDFParse({ data: file.buffer });
                    const pdfData = await parser.getText();
                    const text = (pdfData.text || '')
                        .replace(/\\/g, ' ')
                        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
                        .replace(/\uFFFD/g, '?');
                    combinedText += `\n--- SOURCE: ${file.originalname} ---\n${text}\n`;
                } catch (err) {
                    console.error(`PDF error for ${file.originalname}:`, err);
                } finally {
                    if (parser) await parser.destroy();
                }
                visualParts.push({ type: 'pdf', mimeType, data: fileBase64, name: file.originalname });
            } else {
                visualParts.push({ type: 'image', mimeType, data: fileBase64, name: file.originalname });
            }
        }
        
        const extractedText = combinedText.trim();
        if (extractedText.length < 20 && visualParts.length === 0) {
            return res.status(400).json({ error: 'No readable content found.' });
        }

        const userLang = req.body.lang || 'en';
        const notesLang = { 'en': 'English', 'es': 'Spanish', 'zh': 'Chinese' }[userLang] || 'English';

        const prompt = `You are an expert contract analyst. I will give you the full text of a contract document. Your job is to carefully read and understand the ENTIRE content, then extract the correct structured data.

IMPORTANT: Think step by step before answering. Understand the full context of the document first.

OUTPUT: Return ONLY a single valid JSON object. No markdown code blocks, no explanation text — just raw JSON.

---REQUIRED JSON FIELDS---
{
  "title": string (max 40 chars, in ${notesLang} — e.g. provider + product type),
  "category": one of [Utilities, Insurance, Mobile, Internet, Subscription, Documentation, Other],
  "billing_cycle": one of [Monthly, Annual, Quarterly],
  "_cost_value": number (the actual recurring charge — see cost rules below),
  "_cost_nature": one of [monthly, quarterly, annual, total_over_N] where N = number of months,
  "start_date": DD/MM/YYYY or "",
  "contract_end_date": DD/MM/YYYY or "",
  "permanencia_end_date": DD/MM/YYYY or "" (lock-in/permanencia expiry),
  "notes": string in ${notesLang} — bullet-point summary including: provider, product, Policy Number (if applicable), Customer/Emergency Phone Numbers, core coverage, actual recurring price, duration, and important conditions.
}

---EMERGENCY & SUPPORT EXTRACTION---
If the document is an Insurance policy, Utility contract, or service agreement, you MUST explicitly look for and extract:
- Policy Number / Reference Number
- Customer Service Phone Number
- Emergency / Technical Support Phone Number
- Core Coverage summary (e.g. "Full coverage car insurance", "Fiber 1GB + 2 Mobile Lines")
Always put these prominently at the beginning of the "notes" field as bullet points so the user can easily find them in an emergency.

---COST EXTRACTION — MOST CRITICAL PART---
You MUST distinguish between:
1. The ACTUAL RECURRING CHARGE the customer pays each billing period (this is what we want)
2. Financing sub-components, discounts, or one-time fees embedded in the explanation

To find the real recurring charge:
- If the document has a payment schedule table (e.g. "Forma de Pago / Período / Total con IVA a Pagar"), read the table row for the main recurring period — this is the correct amount
- Narrative text may explain that a price includes a financing component or a promotional discount — do not confuse these sub-components for the total
- The correct _cost_value is what will be charged to the customer's bank account each period going forward

SPECIAL CASE — UPFRONT LUMP-SUM FOR MULTI-YEAR PERIOD:
When a customer pays a SINGLE AMOUNT that covers MULTIPLE YEARS upfront (e.g. "Prima única de 1841.78€ por los 3 primeros años"), you MUST:
- Set _cost_value = the full amount paid (e.g. 1841.78)
- Set _cost_nature = "total_over_N" where N = total number of MONTHS covered (e.g. 3 years = 36 months → "total_over_36")
- This allows the system to correctly compute the monthly equivalent

Examples of correct reasoning:
- "Cuota mensual: 52,03€" → _cost_value = 52.03, _cost_nature = "monthly"
- "Prima total con IVA: 1.200€ anual" → _cost_value = 1200, _cost_nature = "annual"
- "Pago único 1841.78€ por 3 años" → _cost_value = 1841.78, _cost_nature = "total_over_36"
- "Pago único 3600€ por 36 meses de servicio" → _cost_value = 3600, _cost_nature = "total_over_36"
- ID card or passport with no fee → _cost_value = 0

---NOTES FORMATTING---
For the "notes" field:
- Write each bullet point on a SEPARATE LINE. Use "• " prefix for each item.
- Do NOT concatenate all bullets into one long string.
- Example:
  "notes": "• Policy: 12345\n• Emergency Phone: 900 111 222 (24h)\n• Coverage: Fire, water damage, theft"

---COST TAX---
Always use the gross amount including VAT/IVA/taxes, NOT the net/before-tax amount.

---CATEGORY GUIDE---
Utilities = electricity, gas, water | Insurance = any insurance policy | Mobile = phone plan | Internet = fiber/broadband | Subscription = streaming/gym/software | Documentation = IDs/passports/certificates (cost=0) | Other = anything else

---DOCUMENT TEXT---
${extractedText}

---JSON OUTPUT---`;





        try {
            let result = '';
            if (provider === 'openai') {
                const contentArr = [{ type: 'text', text: prompt }];
                visualParts.forEach(p => { if (p.type === 'image') contentArr.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }); });
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: aiModel || 'gpt-4o', messages: [{ role: 'user', content: contentArr }] })
                });
                const data = await r.json();
                result = data.choices?.[0]?.message?.content || '';
            } else if (provider === 'gemini') {
                const partsArr = [{ text: prompt }];
                visualParts.forEach(p => { partsArr.push({ inline_data: { mime_type: p.mimeType, data: p.data } }); });
                const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`, { method: 'POST', body: JSON.stringify({ contents: [{ parts: partsArr }] }) });
                const data = await r.json();
                result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else if (provider === 'claude') {
                const contentArr = [{ type: 'text', text: prompt }];
                visualParts.forEach(p => { 
                    if (p.type === 'pdf') contentArr.push({ type: 'document', source: { type: 'base64', media_type: p.mimeType, data: p.data } });
                    else contentArr.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } });
                });
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                    body: JSON.stringify({ model: aiModel || 'claude-3-5-sonnet-20241022', max_tokens: 1800, messages: [{ role: 'user', content: contentArr }] })
                });
                const data = await r.json();
                result = data.content?.[0]?.text || '';
            } else if (provider === 'nvidia') {
                const contentArr = [{ type: 'text', text: prompt }];
                visualParts.forEach(p => { if (p.type === 'image') contentArr.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }); });
                const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: aiModel || 'meta/llama-3.2-90b-vision-instruct', messages: [{ role: 'user', content: contentArr }] })
                });
                const data = await r.json();
                result = data.choices?.[0]?.message?.content || '';
            }

            // Cleanup & Normalize
            function extractF(text, f, isNum) {
                if (isNum) { const m = text.match(new RegExp('"' + f + '"\\s*:\\s*([\\d.,]+)')); return m ? parseFloat(m[1].replace(',', '.')) : 0; }
                const m = text.match(new RegExp('"' + f + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 's'));
                // For notes, preserve \n as actual newlines
                if (f === 'notes') return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
                return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
            }
            let raw;
            try { raw = JSON.parse((result.match(/\{[\s\S]*\}/) || [result])[0].replace(/[\x00-\x1F\x7F]/g, ' ')); }
            catch (_) { raw = { title: extractF(result, 'title'), category: extractF(result, 'category'), _cost_value: extractF(result, '_cost_value', true), _cost_nature: extractF(result, '_cost_nature'), start_date: extractF(result, 'start_date'), contract_end_date: extractF(result, 'contract_end_date'), permanencia_end_date: extractF(result, 'permanencia_end_date'), notes: extractF(result, 'notes') }; }

            const costValue = parseFloat(raw._cost_value) || 0;
            const nature = (raw._cost_nature || 'monthly').toLowerCase();
            let div = 1;
            if (nature === 'quarterly') div = 3;
            else if (nature === 'annual') div = 12;
            else if (nature.startsWith('total_over_')) div = parseInt(nature.slice(11)) || 1;
            const mCost = parseFloat((costValue / div).toFixed(2));

            const sDate = s => { if (!s || !/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return null; const p = s.split('/'); const d = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00`); return isNaN(d.getTime()) ? null : d; };
            const toStr = d => d ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}` : '';

            let sD = raw.start_date || '', eD = raw.contract_end_date || '', pD = raw.permanencia_end_date || '';
            const ds = sDate(sD), de = sDate(eD);
            if (ds && de && ds >= de) [sD, eD] = [eD, sD];
            if (ds && !de && ds > new Date(Date.now() + 90*86400000) && div > 1) { eD = sD; const cs = new Date(ds); cs.setMonth(cs.getMonth() - div); sD = toStr(cs); }
            if (ds && (!de || ds.getTime() === de?.getTime()) && div > 1) { const ce = new Date(ds); ce.setMonth(ce.getMonth() + div); eD = toStr(ce); }

            res.json({ title: (raw.title || '').slice(0, 40), category: raw.category || 'Other', monthly_cost: mCost, billing_cycle: raw.billing_cycle || 'Monthly', start_date: sD, contract_end_date: eD, permanencia_end_date: pD, notes: raw.notes || '' });
        } catch (e) {
            console.error('AI analysis error:', e);
            res.status(500).json({ error: 'AI analysis failed: ' + e.message });
        }
    });
});

// ─── LOCAL STORAGE UTILITIES ──────────────────────────────────────────
function saveLocalMetadata(category, title, data) {
    try {
        const translatedCat = getTranslatedCategoryName(category || 'Other');
        const cat = sanitizePath(translatedCat);
        const t = sanitizePath(title || 'Untitled');
        const targetDir = path.join(CONTRACTS_DIR, cat, t);
        
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const metadataPath = path.join(targetDir, 'contract_metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2));
        console.log(`[Local] Metadata saved: ${cat}/${t}`);
    } catch (e) {
        console.error('[Local] Metadata save error:', e.message);
    }
}

function cleanupEmptyFolders(category) {
    try {
        const translatedCat = getTranslatedCategoryName(category || 'Other');
        const cat = sanitizePath(translatedCat);
        const catDir = path.join(CONTRACTS_DIR, cat);
        
        if (fs.existsSync(catDir)) {
            const items = fs.readdirSync(catDir);
            if (items.length === 0) {
                fs.rmdirSync(catDir);
                console.log(`[Local] Deleted empty category folder: ${cat}`);
            }
        }
    } catch (e) {
        console.error('[Local] Cleanup error:', e.message);
    }
}

// ─── FILE SYSTEM UTILITIES ──────────────────────────────────────────
function sanitizePath(str) {
    if (!str) return 'Untitled';
    return String(str).replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_').trim();
}

function moveAndRenameFiles(files, category, title) {
    if (!files || !files.length) return null;
    
    const translatedCat = getTranslatedCategoryName(category || 'Other');
    const cat = sanitizePath(translatedCat);
    const t = sanitizePath(title || 'Untitled');
    const targetDir = path.join(CONTRACTS_DIR, cat, t);
    
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const savedPaths = [];
    files.forEach((file, index) => {
        const ext = path.extname(file.originalname) || '.pdf';
        // Format: suffix _2, _3 for additional files
        const suffix = index === 0 ? '' : `_${index + 1}`;
        let newFilename = `${t}${suffix}${ext}`;
        let newPath = path.join(targetDir, newFilename);
        
        let counter = index === 0 ? 2 : (index + 2); // Avoid collision with existing or previous indices
        while (fs.existsSync(newPath)) {
            newFilename = `${t}_${counter}${ext}`;
            newPath = path.join(targetDir, newFilename);
            counter++;
        }

        fs.copyFileSync(file.path, newPath);
        fs.unlinkSync(file.path);
        savedPaths.push(`Contracts/${cat}/${t}/${newFilename}`);
    });

    return savedPaths.join(';');
}


app.get('/api/version', (req, res) => {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        res.json({ version: pkg.version });
    } catch (e) {
        res.json({ version: '1.0.0' });
    }
});

// ─── CONTRACTS API ───────────────────────────────────────────────────────────────────
app.get('/api/contracts', (req, res) => {
    const { all } = req.query;
    // Default: only fetch active (or null for legacy rows)
    const whereClause = all === 'true' ? '' : `WHERE status = 'active' OR status IS NULL`;
    
    db.all(`SELECT * FROM contracts ${whereClause}`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Custom Sort: earliest permanencia_end_date or contract_end_date ASC
        const parseDateVal = (dStr) => {
            if (!dStr) return 9999999999999;
            const p = dStr.split('/');
            if (p.length === 3) return new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00`).getTime();
            const dt = new Date(dStr);
            return isNaN(dt.getTime()) ? 9999999999999 : dt.getTime();
        };

        rows.sort((a, b) => {
            const dA = Math.min(parseDateVal(a.permanencia_end_date), parseDateVal(a.contract_end_date));
            const dB = Math.min(parseDateVal(b.permanencia_end_date), parseDateVal(b.contract_end_date));
            return dA - dB;
        });

        res.json(rows);
    });
});

app.post('/api/contracts/:id/renew', upload.array('document', 10), (req, res) => {
    const { monthly_cost, start_date, contract_end_date, permanencia_end_date } = req.body;
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        
        db.get("SELECT value FROM settings WHERE key = 'xeck_login_mode'", (err, modeRow) => {
            const isLocal = !modeRow || modeRow.value === 'local';
            
            // 1. Archive old
            db.run(`UPDATE contracts SET status = 'archived' WHERE id = ?`, [row.id], (err) => {
                if(err) return res.status(500).json({ error: err.message });
                
                // 2. Insert new
                let file_path = row.file_path;
                if (req.files && req.files.length > 0) {
                    file_path = moveAndRenameFiles(req.files, row.category, row.title);
                }

                db.run(
                    `INSERT INTO contracts (title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes, file_path, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                    [row.title, row.category, monthly_cost ?? row.monthly_cost, row.billing_cycle, start_date || null, contract_end_date || null, permanencia_end_date || null, row.notes, file_path],
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        const newId = this.lastID;
                        const result = { id: newId, title: row.title, category: row.category, monthly_cost, billing_cycle: row.billing_cycle, start_date, contract_end_date, permanencia_end_date, notes: row.notes, file_path, status: 'active' };
                        res.json(result);
                        
                        if (isLocal) {
                            saveLocalMetadata(result.category, result.title, result);
                        } else {
                            triggerBackgroundSync();
                            addCalendarEvent(result);
                        }
                    }
                );
            });
        });
    });
});


app.get('/api/contracts/:id', (req, res) => {
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    });
});

app.post('/api/contracts', upload.array('document', 10), (req, res) => {
    const { title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    
    db.get("SELECT value FROM settings WHERE key = 'xeck_login_mode'", (err, modeRow) => {
        const isLocal = !modeRow || modeRow.value === 'local';
        let file_path = null;
        
        if (req.files && req.files.length > 0) {
            file_path = moveAndRenameFiles(req.files, category, title);
        }

        db.run(
            `INSERT INTO contracts (title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes, file_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title, category || 'Other', monthly_cost || 0, billing_cycle || 'Monthly',
             start_date || null, contract_end_date || null, permanencia_end_date || null, notes || null, file_path],
            function(err) {
                if (err) {
                    console.error("DB INSERT ERROR:", err);
                    return res.status(500).json({ error: err.message });
                }
                const contractId = this.lastID;
                const result = { id: contractId, title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes, file_path };
                res.json(result);
                
                if (isLocal) {
                    saveLocalMetadata(category, title, result);
                } else {
                    triggerBackgroundSync();
                    addCalendarEvent(result);
                }
            }
        );
    });
});

app.put('/api/contracts/:id', upload.array('document', 10), (req, res) => {
    const { title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes } = req.body;
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        
        db.get("SELECT value FROM settings WHERE key = 'xeck_login_mode'", (err, modeRow) => {
            const isLocal = !modeRow || modeRow.value === 'local';
            let file_path = row.file_path;

            if (req.files && req.files.length > 0) {
                file_path = moveAndRenameFiles(req.files, category || row.category, title || row.title);
            } else if (((title && title !== row.title) || (category && category !== row.category))) {
                const oldCat = sanitizePath(row.category || 'Other');
                const oldTitle = sanitizePath(row.title);
                const newCat = sanitizePath(category || row.category || 'Other');
                const newTitle = sanitizePath(title || row.title);
                const oldDir = path.join(CONTRACTS_DIR, oldCat, oldTitle);
                const newDir = path.join(CONTRACTS_DIR, newCat, newTitle);
                if (fs.existsSync(oldDir) && oldDir !== newDir) {
                    if (!fs.existsSync(path.join(CONTRACTS_DIR, newCat))) fs.mkdirSync(path.join(CONTRACTS_DIR, newCat), { recursive: true });
                    try { fs.renameSync(oldDir, newDir); } catch(e) {}
                    if (file_path && file_path.startsWith('Contracts/')) {
                        file_path = `Contracts/${newCat}/${newTitle}/${path.basename(file_path)}`;
                    }
                    cleanupEmptyFolders(row.category);
                }
            }

            db.run(
                `UPDATE contracts SET title=?, category=?, monthly_cost=?, billing_cycle=?, start_date=?, contract_end_date=?, permanencia_end_date=?, notes=?, file_path=? WHERE id=?`,
                [title || row.title, category || row.category, monthly_cost ?? row.monthly_cost, billing_cycle || row.billing_cycle,
                 start_date !== undefined ? start_date : row.start_date,
                 contract_end_date !== undefined ? contract_end_date : row.contract_end_date,
                 permanencia_end_date !== undefined ? permanencia_end_date : row.permanencia_end_date,
                 notes !== undefined ? notes : row.notes, file_path, req.params.id],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    const updatedData = { ...row, title: title || row.title, category: category || row.category, monthly_cost: monthly_cost ?? row.monthly_cost, file_path };
                    res.json({ id: req.params.id, updated: true });
                    if (isLocal) saveLocalMetadata(updatedData.category, updatedData.title, updatedData.id ? updatedData : { ...updatedData, id: req.params.id });
                    else triggerBackgroundSync();
                }
            );
        });
    });
});

app.delete('/api/contracts/:id', (req, res) => {
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        
        let targetDir = null;
        let specificFile = null;
        if (row.file_path) {
            if (row.file_path.startsWith('Contracts/')) {
                // Local Mode structured storage
                targetDir = path.join(dataDir, path.dirname(row.file_path));
            } else {
                // Cloud Mode flat storage (uploads/)
                specificFile = path.join(dataDir, row.file_path);
            }
        }
        
        try {
            if (targetDir && fs.existsSync(targetDir)) {
                fs.rmSync(targetDir, { recursive: true, force: true });
                console.log(`[Delete] Deleted contract directory: ${targetDir}`);
            } else if (specificFile && fs.existsSync(specificFile)) {
                fs.unlinkSync(specificFile);
                console.log(`[Delete] Deleted specific file: ${specificFile}`);
            }
        } catch (e) {
            console.error('Warning: Could not delete contract files:', e.message);
        }
        
        db.run(`DELETE FROM contracts WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: true });
            
            // Local cleanup
            cleanupEmptyFolders(row.category);
            
            // Background cloud delete
            getDriveClient().then(async drive => {
                const rootId = await getOrCreateFolder(drive, 'Xeck_Contracts');
                const fileName = row.file_path ? path.basename(row.file_path) : null;
                if (fileName) {
                    await deleteFromDrive(drive, rootId, req.params.id, row.title, row.category, fileName);
                } else {
                    await updateDriveManifest(drive, rootId);
                }
            }).catch(e => console.log('[Sync] Cloud delete skipped:', e.message));
        });
    });
});

// ─── BACKUP ──────────────────────────────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
    res.attachment('xeck_backup.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).send({ error: err.message }));
    archive.pipe(res);
    archive.file(dbPath, { name: 'contracts.db' });
    archive.directory(UPLOADS_DIR, 'uploads'); // Keep for legacy files
    if (fs.existsSync(CONTRACTS_DIR)) archive.directory(CONTRACTS_DIR, 'Contracts'); // New structure
    archive.finalize();
});

app.post('/api/import', importUpload.single('backup'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No backup file provided.' });
    db.close(err => {
        if (err) return res.status(500).json({ error: 'Failed to close DB' });
        try {
            new AdmZip(req.file.path).extractAllTo(dataDir, true);
            fs.unlinkSync(req.file.path);
            // Reconnect DB after import
            db = new sqlite3.Database(dbPath, (err) => {
                if (err) console.error('Error opening database after import', err.message);
                else console.log('Reconnected to the SQLite database after import.');
            });
            res.json({ message: 'Backup imported!' });
        } catch (e) {
            // Reconnect DB even if extraction fails
            db = new sqlite3.Database(dbPath, (err) => {
                if (err) console.error('Error opening database after failed import', err.message);
                else console.log('Reconnected to the SQLite database after failed import.');
            });
            res.status(500).json({ error: 'Failed to extract backup.' });
        }
    });
});

// ─── GOOGLE OAuth (Desktop App Flow) ───────────────────────────────────────────────────
async function getGoogleConfig() {
    return new Promise((resolve) => {
        db.all("SELECT key, value FROM settings WHERE key IN ('google_client_id', 'google_client_secret')", (err, rows) => {
            const cfg = {};
            if (rows) rows.forEach(r => cfg[r.key] = r.value);
            resolve(cfg);
        });
    });
}

const getRedirectUri = () => {
    const port = server.address().port;
    return `http://localhost:${port}/auth/callback`;
};

app.get('/api/auth/google/url', async (req, res) => {
    const { lang } = req.query; // Get preferred language from frontend
    if (lang) {
        current_language = lang;
        db.run("INSERT INTO settings (key, value) VALUES ('current_language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [lang]);
    }
    const { google_client_id, google_client_secret } = await getGoogleConfig();
    if (!google_client_id) {
        console.error('[OAuth] Missing Client ID in settings');
        return res.status(400).json({ error: 'Google Client ID not set in settings.' });
    }
    console.log('[OAuth] Generating Auth URL with Client ID:', google_client_id.substring(0, 15) + '...');
    const client = new OAuth2Client(google_client_id, google_client_secret, getRedirectUri());
    const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        state: lang || 'en', // Pass language state for callback localization
        hl: lang || 'en', // Set Google UI language
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/calendar.events'
        ]
    });
    res.json({ url });
});

// Endpoint to trigger app focus exactly when the 3s countdown finishes
app.post('/api/auth/finalize', (req, res) => {
    console.log('[Auth] Finalizing: Triggering app-focus signal.');
    authBus.emit('authenticated');
    res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
    db.run("DELETE FROM settings WHERE key IN ('google_tokens', 'profile_name', 'xeck_login_mode')", (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query; // state contains the language
    const lang = state || 'en';
    const { google_client_id, google_client_secret } = await getGoogleConfig();
    try {
        console.log('[OAuth] Callback received, exchanging code...');
        const client = new OAuth2Client(google_client_id, google_client_secret, getRedirectUri());
        
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        
        // 1. Verify ID Token & Get User Info
        let googleName = '';
        try {
            const ticket = await client.verifyIdToken({
                idToken: tokens.id_token,
                audience: google_client_id
            });
            const payload = ticket.getPayload();
            googleName = payload.name;
            console.log('[OAuth] Authenticated as:', payload.email);
        } catch(err) {
            console.warn('[OAuth] Failed to verify ID token:', err.message);
        }

        // 2. Explicitly save tokens and profile name to DB
        console.log('[OAuth] Saving tokens and metadata to DB...');
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                // Save tokens
                db.get("SELECT value FROM settings WHERE key = 'google_tokens'", (err, row) => {
                    let existing = {};
                    if (row) try { existing = JSON.parse(row.value); } catch(e) {}
                    const updated = { ...existing, ...tokens };
                    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('google_tokens', ?)", [JSON.stringify(updated)]);
                });

                // Auto-fill profile name if not set
                if (googleName) {
                    db.get("SELECT value FROM settings WHERE key = 'profile_name'", (err, row) => {
                        if (!row || !row.value) {
                            console.log('[OAuth] Setting profile name to:', googleName);
                            db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('profile_name', ?)", [googleName]);
                        }
                    });
                }

                // Set default mode to google since user just authenticated
                db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('xeck_login_mode', 'google')");
                
                // Finalize sequence
                db.run("SELECT 1", (err) => {
                    if (err) reject(err);
                    else {
                        // We no longer emit authenticated here immediately.
                        // Instead, we wait for the browser countdown to call /api/auth/finalize
                        // so the focus happens synchronized with the transition.
                        resolve();
                    }
                });
            });
        });

        // UI Translations for Success Page
        const translations = {
            en: { title: "Authentication Successful!", sub: "Google Drive has been successfully connected to Xeck.", close: "Close Tab Now", redirecting: "Redirecting" },
            zh: { title: "鉴权成功！", sub: "谷歌网盘已成功连接到 Xeck。", close: "立即关闭", redirecting: "正在跳转" },
            es: { title: "¡Autenticación Exitosa!", sub: "Google Drive se ha conectado correctamente a Xeck.", close: "Cerrar pestaña", redirecting: "Redirigiendo" }
        };
        const t = translations[lang] || translations.en;

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Xeck - ${t.title}</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
                <style>
                    body { font-family: 'Inter', sans-serif; background-color: #F9FAFB; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; color: #111111; }
                    .card { background: white; padding: 3rem; border-radius: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); text-align: center; max-width: 420px; border: 2px solid #EEEEEE; animation: slideUp 0.5s ease-out; }
                    @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                    .icon { width: 72px; height: 72px; background: #10B981; color: white; border-radius: 50%; display: flex; justify-content: center; align-items: center; margin: 0 auto 1.5rem; font-size: 36px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2); }
                    h2 { font-weight: 700; margin-bottom: 0.75rem; font-size: 1.5rem; }
                    p { color: #4B5563; line-height: 1.6; margin-bottom: 2.5rem; font-size: 0.9375rem; }
                    .countdown { font-size: 0.8125rem; color: #9CA3AF; margin-top: 2.5rem; border-top: 1px solid #F3F4F6; padding-top: 1.5rem; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✓</div>
                    <h2>${t.title}</h2>
                    <p>${t.sub}</p>
                    <div class="countdown" id="cd-text">${t.redirecting}: <span id="sec">3</span>s...</div>
                </div>
                <script>
                    let s = 3;
                    const el = document.getElementById('sec');
                    
                    const finishFlow = async () => {
                        console.log("Triggering finalize and cleanup...");
                        
                        // 1. Tell the App to jump into foreground
                        try {
                            // Using fetch with keepalive or sendBeacon to ensure it goes out
                            navigator.sendBeacon('/api/auth/finalize');
                        } catch(e) {}

                        // 2. Try to close the tab
                        window.close();

                        // 3. Fallback: definitely go blank
                        setTimeout(() => {
                            window.location.href = 'about:blank';
                        }, 200);
                    };

                    const timer = setInterval(() => {
                        s--;
                        if (el) el.innerText = s;
                        if (s <= 0) {
                            clearInterval(timer);
                            finishFlow();
                        }
                    }, 1000);
                </script>
            </body>
            </html>
        `);
    } catch (e) {
        console.error('OAuth Error:', e.message);
        res.status(500).send('Authentication failed: ' + e.message);
    }
});

// ─── GOOGLE DRIVE SYNC ───────────────────────────────────────────────────────────────
async function getDriveClient() {
    const { google_client_id, google_client_secret } = await getGoogleConfig();
    return new Promise((resolve, reject) => {
        db.get("SELECT value FROM settings WHERE key = 'xeck_login_mode'", (err, modeRow) => {
            if (modeRow && modeRow.value === 'local') {
                return reject(new Error('Cloud sync disabled in Local mode'));
            }
            
            db.get("SELECT value FROM settings WHERE key = 'google_tokens'", (err, row) => {
                if (err || !row) return reject(new Error('Not authenticated'));
                const tokens = JSON.parse(row.value);
                const auth = new google.auth.OAuth2(google_client_id, google_client_secret, getRedirectUri());
                auth.setCredentials(tokens);

                // --- ENHANCEMENT: Automatic Token Refresh Persistence ---
                auth.on('tokens', (newTokens) => {
                    console.log('[OAuth] Tokens refreshed automatically, saving to DB...');
                    const updatedTokens = { ...tokens, ...newTokens };
                    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ['google_tokens', JSON.stringify(updatedTokens)]);
                });

                resolve(google.drive({ version: 'v3', auth }));
            });
        });
    });
}

async function getOrCreateFolder(drive, folderName, parentId = null) {
    const query = [
        `name = '${folderName}'`,
        `mimeType = 'application/vnd.google-apps.folder'`,
        `trashed = false`
    ];
    if (parentId) query.push(`'${parentId}' in parents`);
    
    const res = await drive.files.list({
        q: query.join(' and '),
        fields: 'files(id, name)',
    });
    if (res.data.files.length > 0) return res.data.files[0].id;

    // --- ENHANCEMENT: Migration Check ---
    // If the folder is a CATEGORY (parentId is Xeck_Contracts root), 
    // check if it exists in another language and RENAME it instead of creating new.
    if (parentId) {
        // Find which category key matches this folderName in ANY language
        let catKey = null;
        for (const lang of Object.keys(CATEGORY_I18N)) {
            const found = Object.keys(CATEGORY_I18N[lang]).find(k => CATEGORY_I18N[lang][k] === folderName);
            if (found) { catKey = found; break; }
        }

        if (catKey) {
            const allAlts = getAllPossibleCategoryNames(catKey);
            const altQueries = allAlts.map(alt => `name = '${alt}'`);
            const altSearch = await drive.files.list({
                q: `(${altQueries.join(' or ')}) and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
                fields: 'files(id, name)'
            });

            if (altSearch.data.files.length > 0) {
                const existingFolderId = altSearch.data.files[0].id;
                console.log(`[Sync] Renaming Drive folder: ${altSearch.data.files[0].name} -> ${folderName}`);
                await drive.files.update({
                    fileId: existingFolderId,
                    resource: { name: folderName }
                });
                return existingFolderId;
            }
        }
    }

    const folderMetadata = { 
        name: folderName, 
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };
    const folder = await drive.files.create({ resource: folderMetadata, fields: 'id' });
    return folder.data.id;
}

app.get('/api/check-updates', (req, res) => {
    console.log('[API] Check for updates requested');
    updateProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0, status: 'checking' };
    updateBus.emit('check-update', (result) => {
        result.isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
        res.json(result);
    });
});

app.post('/api/start-update', (req, res) => {
    updateBus.emit('start-update');
    res.json({ ok: true });
});

app.post('/api/install-update', (req, res) => {
    updateBus.emit('install-update');
    res.json({ ok: true });
});

app.get('/api/update-progress', (req, res) => {
    res.json(updateProgress);
});



async function updateDriveManifest(drive, rootId) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM contracts", [], async (err, contracts) => {
            if (err) return reject(err);
            try {
                const manifest = {
                    version: '1.0',
                    lastUpdated: new Date().toISOString(),
                    contracts: contracts.map(c => ({
                        id: c.id,
                        title: c.title,
                        category: c.category,
                        monthly_cost: c.monthly_cost,
                        billing_cycle: c.billing_cycle,
                        start_date: c.start_date,
                        contract_end_date: c.contract_end_date,
                        permanencia_end_date: c.permanencia_end_date,
                        notes: c.notes,
                        file_name: c.file_path ? path.basename(c.file_path) : null
                    }))
                };

                const fileName = 'xeck_manifest.json';
                const searchRes = await drive.files.list({
                    q: `name = '${fileName}' and '${rootId}' in parents and trashed = false`,
                    fields: 'files(id)'
                });

                const media = {
                    mimeType: 'application/json',
                    body: JSON.stringify(manifest, null, 2)
                };

                if (searchRes.data.files.length > 0) {
                    const fileId = searchRes.data.files[0].id;
                    if (contracts.length === 0) {
                        await drive.files.delete({ fileId });
                        console.log('[Sync] Manifest deleted because no contracts remain.');
                    } else {
                        await drive.files.update({ fileId, media });
                        console.log('[Sync] Manifest updated.');
                    }
                } else if (contracts.length > 0) {
                    await drive.files.create({
                        requestBody: { name: fileName, parents: [rootId] },
                        media
                    });
                    console.log('[Sync] Manifest created.');
                }
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function deleteFromDrive(drive, rootId, contractId, title, category, fileName) {
    try {
        if (fileName) {
            console.log(`[Sync] Attempting to delete ${fileName} from Drive...`);
            const searchRes = await drive.files.list({
                q: `name = '${fileName}' and trashed = false`,
                fields: 'files(id)'
            });
            for (const file of searchRes.data.files) {
                await drive.files.delete({ fileId: file.id });
                console.log(`[Sync] Deleted file ${file.id} (${fileName})`);
            }
        }

        const translatedCat = getTranslatedCategoryName(category || 'Other');
        const cat = sanitizePath(translatedCat);
        const t = sanitizePath(title || 'Untitled');
        
        const catRes = await drive.files.list({
            q: `name = '${cat}' and '${rootId}' in parents and trashed = false`,
            fields: 'files(id)'
        });
        
        if (catRes.data.files.length > 0) {
            const catId = catRes.data.files[0].id;
            const titleRes = await drive.files.list({
                q: `name = '${t}' and '${catId}' in parents and trashed = false`,
                fields: 'files(id)'
            });
            
            if (titleRes.data.files.length > 0) {
                const titleId = titleRes.data.files[0].id;
                
                // Explicitly delete contract_metadata.json if it exists
                const metaSearch = await drive.files.list({
                    q: `name = 'contract_metadata.json' and '${titleId}' in parents and trashed = false`,
                    fields: 'files(id)'
                });
                for (const meta of metaSearch.data.files) {
                    await drive.files.delete({ fileId: meta.id });
                    console.log(`[Sync] Deleted metadata ${meta.id} on Drive`);
                }

                const children = await drive.files.list({
                    q: `'${titleId}' in parents and trashed = false`,
                    fields: 'files(id)'
                });
                if (children.data.files.length === 0) {
                    await drive.files.delete({ fileId: titleId });
                    console.log(`[Sync] Deleted empty title folder ${titleId} (${t})`);
                    
                    // Also check if Category folder is now empty
                    const catChildren = await drive.files.list({
                        q: `'${catId}' in parents and trashed = false`,
                        fields: 'files(id)'
                    });
                    // Only manifest should stay in rootId; catFolders are children of rootId
                    // but we verify catId's own children (which are other title folders)
                    if (catChildren.data.files.length === 0) {
                        await drive.files.delete({ fileId: catId });
                        console.log(`[Sync] Deleted empty category folder ${catId} (${cat})`);
                    }
                }
            }
        }
        
        await updateDriveManifest(drive, rootId);
    } catch (e) {
        console.error('[Sync] Delete error:', e.message);
    }
}

// --- GOOGLE CALENDAR EVENT ---
async function addCalendarEvent(contract) {
    db.get("SELECT value FROM settings WHERE key = 'google_tokens'", async (err, row) => {
        if (!row || !row.value) return;
        try {
            const { google_client_id, google_client_secret } = await getGoogleConfig();
            if (!google_client_id) return;
            const client = new OAuth2Client(google_client_id, google_client_secret, getRedirectUri());
            client.setCredentials(JSON.parse(row.value));
            
            const calendar = google.calendar({version: 'v3', auth: client});
            
            const targetDateStr = contract.permanencia_end_date || contract.contract_end_date;
            if (!targetDateStr) return;
            
            const [d, m, y] = targetDateStr.split('/');
            if (!d || !m || !y) return;
            const eventDate = `${y}-${m}-${d}T10:00:00`;
            const endDate = `${y}-${m}-${d}T11:00:00`;
            
            const event = {
                summary: `Xeck Renewal: ${contract.title}`,
                description: `Xeck Automated Reminder\nCategory: ${contract.category}\nCost: ${contract.monthly_cost}`,
                start: { dateTime: eventDate, timeZone: 'UTC' },
                end: { dateTime: endDate, timeZone: 'UTC' },
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'email', minutes: 30 * 24 * 60 } // 30 days before
                    ]
                }
            };

            await calendar.events.insert({
                calendarId: 'primary',
                resource: event,
            });
            console.log('[Calendar] Created event for ' + contract.title);
        } catch (e) {
            console.error('[Calendar] Error creating event:', e.message);
        }
    });
}

async function triggerBackgroundSync() {
    try {
        const drive = await getDriveClient();
        const rootId = await getOrCreateFolder(drive, 'Xeck_Contracts');
        
        // 1. Sync files
        db.all("SELECT * FROM contracts", [], async (err, contracts) => {
            if (err) return;
            for (const c of contracts) {
                if (!c.file_path) continue;
                const translatedCat = getTranslatedCategoryName(c.category || 'Other');
                const cat = sanitizePath(translatedCat);
                const title = sanitizePath(c.title || 'Untitled');
                const fileName = path.basename(c.file_path);

                const catId = await getOrCreateFolder(drive, cat, rootId);
                const titleId = await getOrCreateFolder(drive, title, catId);

                // 1.1 Sync contract_metadata.json
                const metadataFileName = 'contract_metadata.json';
                const metadataSearch = await drive.files.list({
                    q: `name = '${metadataFileName}' and '${titleId}' in parents and trashed = false`,
                    fields: 'files(id)'
                });
                
                const metadataContent = JSON.stringify({
                    id: c.id, title: c.title, category: c.category,
                    monthly_cost: c.monthly_cost, billing_cycle: c.billing_cycle,
                    start_date: c.start_date, contract_end_date: c.contract_end_date,
                    permanencia_end_date: c.permanencia_end_date, notes: c.notes
                }, null, 2);

                if (metadataSearch.data.files.length === 0) {
                    await drive.files.create({
                        requestBody: { name: metadataFileName, parents: [titleId] },
                        media: { mimeType: 'application/json', body: metadataContent }
                    });
                } else {
                    await drive.files.update({
                        fileId: metadataSearch.data.files[0].id,
                        media: { mimeType: 'application/json', body: metadataContent }
                    });
                }

                // 1.2 Sync PDF/Image files
                const filePaths = c.file_path.split(';').filter(p => p.trim());
                for (const p of filePaths) {
                    const fileName = path.basename(p);
                    const searchRes = await drive.files.list({
                        q: `name = '${fileName}' and '${titleId}' in parents and trashed = false`,
                        fields: 'files(id)'
                    });

                    if (searchRes.data.files.length === 0) {
                        const absPath = path.join(DATA_DIR, p);
                        if (fs.existsSync(absPath)) {
                            console.log(`[Sync] Uploading to Drive: ${fileName}`);
                            await drive.files.create({
                                requestBody: {
                                    name: fileName,
                                    parents: [titleId],
                                    appProperties: { id: c.id.toString(), title: c.title, category: c.category }
                                },
                                media: { body: fs.createReadStream(absPath) }
                            });
                        }
                    }
                }
            }
            // 2. Update Manifest
            await updateDriveManifest(drive, rootId);
        });
    } catch (e) {
        console.log('[Sync] Background sync skipped:', e.message);
    }
}


app.post('/api/sync', async (req, res) => {
    try {
        const drive = await getDriveClient();
        const rootId = await getOrCreateFolder(drive, 'Xeck_Contracts');

        // 1. Fetch ALL local contracts
        db.all("SELECT * FROM contracts", [], async (err, contracts) => {
            if (err) return;
            
            for (const c of contracts) {
                if (!c.file_path) continue;
                
                // Use translated category for current sync path
                const translatedCat = getTranslatedCategoryName(c.category || 'Other');
                const cat = sanitizePath(translatedCat);
                const title = sanitizePath(c.title || 'Untitled');
                // 1.2 Sync PDF/Image files
                const filePaths = c.file_path.split(';').filter(p => p.trim());
                for (const p of filePaths) {
                    const fileName = path.basename(p);
                    const searchRes = await drive.files.list({
                        q: `name = '${fileName}' and '${titleId}' in parents and trashed = false`,
                        fields: 'files(id)'
                    });

                    if (searchRes.data.files.length === 0) {
                        const absPath = path.join(DATA_DIR, p);
                        if (fs.existsSync(absPath)) {
                            await drive.files.create({
                                requestBody: {
                                    name: fileName,
                                    parents: [titleId],
                                    appProperties: { id: c.id.toString(), title: c.title, category: c.category }
                                },
                                media: { body: fs.createReadStream(absPath) }
                            });
                        }
                    }
                }
            }
            // 2. Update Manifest
            await updateDriveManifest(drive, rootId);
        });

        // 2. Fetch cloud files (scan all levels)
        // Note: For simplicity and performance, we scan the root recursively if possible, 
        // but Drive v3 list isn't natively recursive easily without multiple calls.
        // We focus on the current structure for sync completeness.
        
        res.json({ success: true, message: 'Sync started', lastSync: new Date().toISOString() });
    } catch (e) {
        console.error('--- SYNC ERROR DETAIL ---');
        console.error('Message:', e.message);
        
        // Specific handling for disabled API
        if (e.message.includes('disabled') || (e.response && e.response.data && JSON.stringify(e.response.data).includes('SERVICE_DISABLED'))) {
            const projectMatch = e.message.match(/project (\d+)/) || (e.response && JSON.stringify(e.response.data).match(/project\s*[:=]\s*(\d+)/));
            const projectId = projectMatch ? projectMatch[1] : 'your-project-id';
            return res.status(403).json({ 
                error: 'API_DISABLED', 
                message: 'Google Drive API is not enabled.',
                url: `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${projectId}`
            });
        }

        if (e.response && e.response.data) {
            console.error('Data:', JSON.stringify(e.response.data));
        }
        console.error('Stack:', e.stack);
        console.error('--------------------------');
        res.status(500).json({ error: e.message });
    }
});

server.listen(0, async () => {
    const port = server.address().port;
    console.log(`Xeck backend running at http://localhost:${port}`);
    
    // Ensure we load the last saved language state
    await loadServerLanguage();
    
    // If running in Electron, we might want to notify the main process
    if (process.send) {
        process.send({ type: 'PORT', port: port });
    }
});

// For Electron integration if required as a module
const setUpdateProgress = (prog) => {
    updateProgress = { ...updateProgress, ...prog };
};
module.exports = { app, server, authBus, updateBus, setUpdateProgress };


