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

const authBus = new EventEmitter();

const CATEGORY_I18N = {
    en: {
        cat_utilities: "Utilities", cat_insurance: "Insurance", cat_mobile: "Mobile",
        cat_subscription: "Subscription", cat_internet: "Internet", cat_other: "Other"
    },
    es: {
        cat_utilities: "Servicios", cat_insurance: "Seguros", cat_mobile: "Móvil",
        cat_subscription: "Suscripción", cat_internet: "Internet", cat_other: "Otro"
    },
    zh: {
        cat_utilities: "水电煤", cat_insurance: "保险", cat_mobile: "通信",
        cat_subscription: "订阅", cat_internet: "宽带", cat_other: "其他"
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

const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const app = express();
const port = 3000;

const DATA_DIR = process.env.XECK_DATA_DIR || __dirname;
console.log(`[Server] Using Data Directory: ${DATA_DIR}`);

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const CONTRACTS_DIR = path.join(DATA_DIR, 'Contracts');
if (!fs.existsSync(CONTRACTS_DIR)) fs.mkdirSync(CONTRACTS_DIR, { recursive: true });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
app.use('/Contracts', express.static(path.join(DATA_DIR, 'Contracts')));
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

const DB_FILE = path.join(DATA_DIR, 'contracts.db');
let db;

function connectDB() {
    db = new sqlite3.Database(DB_FILE, (err) => {
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
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);

            // --- AUTO-CONFIGURE GOOGLE OAUTH ---
            const GOOGLE_CLIENT_ID = "72199376080-i9nv5ru4vcg0p9uvbvfssi8ej162lbii.apps.googleusercontent.com";
            const GOOGLE_CLIENT_SECRET = "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";
            
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('google_client_id', ?)", [GOOGLE_CLIENT_ID]);
            db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('google_client_secret', ?)", [GOOGLE_CLIENT_SECRET]);

            // Migrations for existing DBs
            const migrations = [
                `ALTER TABLE contracts ADD COLUMN category TEXT DEFAULT 'Other'`,
                `ALTER TABLE contracts ADD COLUMN billing_cycle TEXT DEFAULT 'Monthly'`,
                `ALTER TABLE contracts ADD COLUMN start_date TEXT`,
                `ALTER TABLE contracts ADD COLUMN contract_end_date TEXT`,
                `ALTER TABLE contracts ADD COLUMN notes TEXT`,
                `ALTER TABLE contracts ADD COLUMN created_at TEXT`
            ];
            migrations.forEach(sql => db.run(sql, () => {}));
        });
    });
}
connectDB();

// Multer for contract documents
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Multer for backup import
const importUpload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, './'),
    filename: (req, file, cb) => cb(null, 'imported_backup.zip')
})});

// Multer for AI analysis (keep in memory, max 20MB)
const analyzeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 鈹€鈹€鈹€ SETTINGS API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
You are a senior professional contract management consultant. 
Analyze the following user contract data and provide strategic advice.
User contracts: ${JSON.stringify(contractsSummary)}

Please provide:
1. **Financial Audit**: Identify high-expense categories and total monthly commitment.
2. **Upcoming Risks**: Warn about contracts ending soon or those with complex billing.
3. **Saving Opportunities**: Suggest where the user could bundle services (e.g., combining mobile and internet) or renegotiate.
4. **Actionable Suggestions**: 3-5 clear, professional steps to optimize their current portfolio.

IMPORTANT: 
- Provide the response in ${lang === 'zh' ? 'Chinese' : lang === 'es' ? 'Spanish' : 'English'}.
- Use professional, helpful, and concise language.
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
                        body: JSON.stringify({ contents: [{ parts: [{ text: advicePrompt }] }] })
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

// 鈹€鈹€鈹€ AI CONTRACT ANALYSIS 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
app.post('/api/analyze-contract', analyzeUpload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Load settings
    db.all(`SELECT key, value FROM settings`, [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const cfg = {};
        rows.forEach(r => { cfg[r.key] = r.value; });

        const provider = cfg.ai_provider || '';
        const apiKey = cfg.ai_api_key || '';
        const aiModel = cfg.ai_model || '';

        if (!provider || !apiKey) {
            return res.status(400).json({ error: 'No AI provider configured. Go to Settings to add one.' });
        }

        const fileBase64 = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype || 'application/pdf';
        const isPdf = mimeType === 'application/pdf' || (req.file.originalname && req.file.originalname.toLowerCase().endsWith('.pdf'));
        let extractedText = '';

        if (isPdf) {
            let parser = null;
            try {
                parser = new PDFParse({ data: req.file.buffer });
                const pdfData = await parser.getText();
                // Sanitize: remove backslashes and invalid Unicode escape sequences that break JSON later
                extractedText = (pdfData.text || '')
                    .replace(/\\/g, ' ')       // remove backslashes
                    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')  // remove control chars
                    .replace(/\uFFFD/g, '?');   // replace replacement chars
            } catch (err) {
                console.error('PDF parsing error:', err);
            } finally {
                if (parser) await parser.destroy();
            }
        }

        if (isPdf && extractedText.trim().length < 20 && (provider === 'nvidia' || provider === 'openai')) {
            return res.status(400).json({ error: 'This PDF appears to be a scanned image (no readable text). The selected AI model (NVIDIA/OpenAI) requires text-based PDFs or direct Image uploads (JPG/PNG). Please convert to an image or try Gemini/Claude.' });
        }

        const userLang = req.body.lang || 'en';
        const notesLang = { 'en': 'English', 'es': 'Spanish', 'zh': 'Chinese' }[userLang] || 'English';

        // Pre-extract key facts from the full text using regex
        let keyFacts = '';
        let regexDates = [];
        if (extractedText) {
            const fullText = extractedText;

            // Extract all dates in common formats
            regexDates = fullText.match(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de \d{4}/gi) || [];

            // Extract all monetary values
            const moneyMatches = fullText.match(/[\d][\d.,]*\s*(?:€|EUR|USD|GBP)|(?:€|EUR|USD|GBP|\$|£)\s*[\d][\d.,]*/g) || [];

            // Extract lines containing key financial/date keywords
            const keyLines = fullText.split('\n')
                .filter(l => /válida|hasta|desde|vigencia|prima|total|precio|fecha|inicio|fin|renovaci|period|anual|trimest|mensual|efecto|cobertura|vencimiento/i.test(l))
                .map(l => l.trim())
                .filter(l => l.length > 5)
                .slice(0, 30);

            keyFacts = `KEY EXTRACTED FACTS FROM DOCUMENT:
Dates found (in order of appearance): ${[...new Set(regexDates)].join(', ') || 'none'}
Amounts found: ${[...new Set(moneyMatches)].join(', ') || 'none'}
Key lines:
${keyLines.join('\n')}
---`;
        }

        // ─── LLM reads the whole document, labels what it finds — Code does the math ─
        const intelligentPrompt = `You are an expert contract analyst. Read the ENTIRE document carefully, understand its structure, then return ONLY valid JSON — no markdown, no explanation.

⚠️ RULE 1: TRANSLATION & FLUENCY (NON-NEGOTIABLE)
1. FIRST, analyze the document in its ORIGINAL native language to ensure extreme accuracy and prevent hallucination.
2. THEN, translate your final findings for the "notes", "title", "category", and "billing_cycle" fields into exactly this language: ${notesLang}.
3. The "notes" field MUST be written in highly fluent, natural, and professional ${notesLang}.
   - If ${notesLang} is Chinese, use standard modern vocabulary (e.g., use "提供商" instead of "供府", "服务内容" instead of "互务资料").
   - DO NOT hallucinate, do not invent weird terminology, and DO NOT use broken characters or strange punctuation (like ‰).
4. Format the "notes" strictly as a bulleted list (-) covering: Provider Name, Coverage/Service Details, Cost Summary, and Duration.

── STEP 1: Understand the document ──
Read everything. What is this contract? Who is the provider? What does it cost and how?

── STEP 2: Extract the cost ──
A document may contain MANY numbers. Your task: find the ONE number that is the actual contract cost the customer pays, and label what kind of amount it is.

Return two cost fields:
- "_cost_value": Copy the number EXACTLY from the document (e.g. 1841.78). Do NOT round or modify it.
- "_cost_nature": A label telling us what kind of amount _cost_value is. Use EXACTLY one of:
    "monthly"         -> _cost_value is already a per-month charge (e.g. "29.99 EUR/mes", "15 USD/month")
    "quarterly"       -> _cost_value is a per-quarter charge (e.g. "89.97 EUR/trimestre")
    "annual"          -> _cost_value is a 12-month total (e.g. "720 EUR/ano", "annual fee 720 EUR")
    "total_over_N"    -> _cost_value is a lump sum covering N months (replace N with the actual integer)
                         Examples: "1841.78 EUR for 3 years" -> "total_over_36"
                                   "500 EUR for 2 years"     -> "total_over_24"
                                   "200 EUR for 6 months"    -> "total_over_6"

  DECISION RULES (apply in order, use first match):
  1. Document shows a clear monthly unit price (EUR/mes, /month, mensual) -> use it, nature="monthly"
  2. Document shows a clear quarterly price -> use it, nature="quarterly"
  3. Document shows an annual price (precio anual, /ano, anual, yearly) -> use it, nature="annual"
  4. Document shows a multi-year lump sum (prima unica, total N anos, one-time for N years) -> use that total, nature="total_over_[months]"
  5. Document shows BOTH a monthly rate AND an annual/lump-sum total -> prefer the monthly rate, nature="monthly"
  6. No clear price found -> set _cost_value=0, nature="monthly"

── STEP 3: Extract all other fields ──
- title: Short name max 40 chars. Format "Provider ServiceType". NEVER leave blank.
- category: One of: Utilities, Insurance, Mobile, Internet, Subscription, Other
- billing_cycle: How often the customer actually gets invoiced: "Monthly", "Annual", or "Quarterly"
- start_date: The contract START date (the earliest/first date). Look for: "valida desde", "efecto", "inicio", "desde el". Use DD/MM/YYYY format.
- contract_end_date: The contract EXPIRY date (the latest/last date). Look for: "vencimiento", "valida hasta", "hasta el", "fin". Use DD/MM/YYYY format.
  RULE: start_date MUST be strictly earlier than contract_end_date. They can NEVER be the same date.
  DATE FORMAT RULE: Always output dates as DD/MM/YYYY (e.g. "06/08/2025" for 6th of August 2025).
- permanencia_end_date: Lock-in period end date in DD/MM/YYYY format. Use empty string "" if not applicable.
- notes: Write ONLY in ${notesLang}. Include: provider name, what is covered/provided, cost summary, contract duration, key highlights.

${keyFacts}

Return ONLY this JSON object, nothing else before or after it:
{"title":"","category":"","billing_cycle":"","_cost_value":0,"_cost_nature":"monthly","start_date":"","contract_end_date":"","permanencia_end_date":"","notes":""}

Full document text:
${extractedText ? extractedText : '(no text extracted)'}`;



        try {
            let result;

            if (provider === 'openai') {
                const contentArr = [{ type: 'text', text: intelligentPrompt }];
                if (!isPdf && !extractedText) {
                    contentArr.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBase64}` } });
                }
                const body = {
                    model: aiModel || 'gpt-4o',
                    messages: [{ role: 'user', content: contentArr }],
                    max_tokens: 1800
                };
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify(body)
                });
                const data = await r.json();
                if (!r.ok) return res.status(502).json({ error: data.error?.message || 'OpenAI error' });
                result = data.choices[0].message.content;

            } else if (provider === 'gemini') {
                const modelId = aiModel || 'gemini-2.0-flash';
                const partsArr = [{ text: intelligentPrompt }];
                // Gemini can handle both PDF binary AND image data natively — always send the file
                partsArr.push({ inline_data: { mime_type: mimeType, data: fileBase64 } });
                const body = { contents: [{ parts: partsArr }] };
                const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
                );
                const data = await r.json();
                if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Gemini error' });
                result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            } else if (provider === 'claude') {
                const contentArr = [{ type: 'text', text: intelligentPrompt }];
                if (!extractedText && mimeType === 'application/pdf') {
                    contentArr.push({ type: 'document', source: { type: 'base64', media_type: mimeType, data: fileBase64 } });
                } else if (!extractedText) {
                    contentArr.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBase64 } });
                }
                const body = {
                    model: aiModel || 'claude-3-5-sonnet-20241022',
                    max_tokens: 1800,
                    messages: [{ role: 'user', content: contentArr }]
                };
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(body)
                });
                const data = await r.json();
                if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Claude error' });
                result = data.content?.[0]?.text || '';

            } else if (provider === 'nvidia') {
                const contentArr = [{ type: 'text', text: intelligentPrompt }];
                if (!isPdf && !extractedText) {
                    contentArr.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBase64}` } });
                }
                const body = {
                    model: aiModel || 'meta/llama-3.2-90b-vision-instruct',
                    messages: [{ role: 'user', content: contentArr }],
                    max_tokens: 1800
                };
                const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify(body)
                });
                const data = await r.json();
                if (!r.ok) {
                    console.error('NVIDIA API Response Error:', JSON.stringify(data, null, 2));
                    return res.status(502).json({ error: data.error?.message || 'NVIDIA error' });
                }
                result = data.choices?.[0]?.message?.content || '';

            } else {
                return res.status(400).json({ error: 'Unknown provider: ' + provider });
            }

            console.log('--- RAW LLM RESULT START ---');
            console.log(result);
            console.log('--- RAW LLM RESULT END ---');

            // ─── Robust field-by-field extraction ─────────────────────────────────
            function extractField(text, field, isNumber) {
                if (isNumber) {
                    const re = new RegExp('"' + field + '"\\s*:\\s*([\\d.,]+)');
                    const m = text.match(re);
                    if (!m) return 0;
                    let numStr = m[1];
                    // Handle European format: 1.841,78 (dot=thousands, comma=decimal)
                    if (numStr.includes('.') && numStr.includes(',')) {
                        numStr = numStr.replace(/\./g, '').replace(',', '.');
                    } else {
                        numStr = numStr.replace(',', '.'); // 1841,78 → 1841.78
                    }
                    return parseFloat(numStr) || 0;
                }
                const re = new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 's');
                const m = text.match(re);
                if (!m) return '';
                return m[1].replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\r/g, ' ')
                           .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\./g, ' ');
            }

            let raw;
            try {
                // FIRST ATTEMPT: Native JSON parse (most accurate for numbers like 1841.78)
                let cleaned = (result.match(/\{[\s\S]*\}/) || [result])[0];
                cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\\(?!["\\\/bfnrtu])/g, ' ');
                raw = JSON.parse(cleaned);

                // Ensure it has basic structure required by Phase 2/3
                if (!raw._cost_value && !raw.title && !raw.category) {
                    throw new Error('JSON parsed but missing structural fields, falling back to regex extraction');
                }
                
                // If start_date exists but end_date doesn't, ensure they're at least empty strings for the sanity checker
                raw.start_date = raw.start_date || '';
                raw.contract_end_date = raw.contract_end_date || '';
                raw.permanencia_end_date = raw.permanencia_end_date || '';

            } catch (_) {
                // FALLBACK: Regex extraction if LLM returned malformed JSON
                console.log('[analyze] Native parse failed, falling back to extractField regex');
                const candidate = {
                    title:                extractField(result, 'title'),
                    category:             extractField(result, 'category') || 'Other',
                    billing_cycle:        extractField(result, 'billing_cycle') || 'Monthly',
                    _cost_value:          extractField(result, '_cost_value', true),
                    _cost_nature:         extractField(result, '_cost_nature') || 'monthly',
                    start_date:           extractField(result, 'start_date'),
                    contract_end_date:    extractField(result, 'contract_end_date'),
                    permanencia_end_date: extractField(result, 'permanencia_end_date'),
                    notes:                extractField(result, 'notes'),
                };
                raw = candidate;
            }

            // ─── PHASE 1.5: Normalize LLM fields to canonical English values ──────
            // LLMs sometimes return values in the document language (e.g. "Mensual", "月付").
            // We must normalize to the English enum values the DB and frontend expect.
            const BILLING_NORM = {
                mensual:'Monthly', monthly:'Monthly', 'per month':'Monthly', 'al mes':'Monthly',
                trimestral:'Quarterly', quarterly:'Quarterly', 'per quarter':'Quarterly',
                anual:'Annual', annual:'Annual', yearly:'Annual', 'per year':'Annual', 'al año':'Annual',
                '月付':'Monthly','月缴':'Monthly','按月':'Monthly',
                '季付':'Quarterly','季缴':'Quarterly','按季':'Quarterly',
                '年付':'Annual','年缴':'Annual','按年':'Annual'
            };
            const CAT_NORM = {
                insurance:'Insurance', seguros:'Insurance', seguro:'Insurance', '保险':'Insurance',
                utilities:'Utilities', servicios:'Utilities', suministros:'Utilities', '水电':'Utilities','水电煤':'Utilities',
                mobile:'Mobile', móvil:'Mobile', movil:'Mobile', '手机':'Mobile','通信':'Mobile',
                internet:'Internet', banda:'Internet', broadband:'Internet', '宽带':'Internet',
                subscription:'Subscription', suscripción:'Subscription', suscripcion:'Subscription', '订阅':'Subscription',
                other:'Other', otro:'Other', otros:'Other', '其他':'Other'
            };
            if (raw.billing_cycle) {
                const normBill = BILLING_NORM[(raw.billing_cycle || '').toLowerCase().trim()];
                if (normBill) raw.billing_cycle = normBill;
                else raw.billing_cycle = 'Monthly'; // safe fallback
            }
            if (raw.category) {
                const normCat = CAT_NORM[(raw.category || '').toLowerCase().trim()];
                if (normCat) raw.category = normCat;
                // else keep whatever LLM returned (it may already be correct English)
            }

            // ─── PHASE 2: Code maps _cost_nature → divisor, performs exact division ─
            //
            // The LLM told us WHAT kind of amount it found.
            // We map that label to a divisor and do one division.
            // No hardcoded scenario logic — the LLM's own label drives everything.
            //
            //   "monthly"        → already per-month  → ÷ 1
            //   "quarterly"      → per-quarter        → ÷ 3
            //   "annual"         → per-year           → ÷ 12
            //   "total_over_N"   → lump sum / N months → ÷ N

            const costValue = parseFloat(raw._cost_value) || 0;
            const nature    = (raw._cost_nature || 'monthly').toLowerCase().trim();

            let divisor = 1;
            if (nature === 'quarterly') {
                divisor = 3;
            } else if (nature === 'annual') {
                divisor = 12;
            } else if (nature.startsWith('total_over_')) {
                const n = parseInt(nature.replace('total_over_', ''), 10);
                divisor = (!isNaN(n) && n > 0) ? n : 1;
            }
            // "monthly" or unrecognised → divisor stays 1

            const monthlyCost = parseFloat((costValue / divisor).toFixed(2));
            console.log(`[analyze] _cost_value=${costValue} / _cost_nature="${nature}" / divisor=${divisor} → monthly_cost=${monthlyCost}`);

            // ─── Date sanity: 3 auto-fixes ────────────────────────────────────────
            // We now operate heavily on DD/MM/YYYY natively.
            function safeDate(s) {
                if (!s || !/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return null;
                const parts = s.split('/');
                const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`);
                return isNaN(d.getTime()) ? null : d;
            }

            function toDDMMYYYY(dateObj) {
                if (!dateObj) return '';
                const dd = String(dateObj.getDate()).padStart(2, '0');
                const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                const yyyy = dateObj.getFullYear();
                return `${dd}/${mm}/${yyyy}`;
            }

            let startDate = raw.start_date           || '';
            let endDate   = raw.contract_end_date    || '';
            let permDate  = raw.permanencia_end_date || '';

            const today = new Date();

            // Fix 1: start >= end → LLM swapped them, swap back
            const dStart = safeDate(startDate);
            const dEnd   = safeDate(endDate);
            if (dStart && dEnd && dStart >= dEnd) {
                console.log('[date-fix] start>=end, swapping:', startDate, '↔', endDate);
                [startDate, endDate] = [endDate, startDate];
            }

            // Fix 2: Only start_date is filled, it's a future date AND we know the contract
            //        duration → LLM almost certainly put the END date in the start_date field.
            //        Reconstruct real start = end - divisor months.
            const dStartA = safeDate(startDate);
            const dEndA   = safeDate(endDate);
            const threeMonthsFromNow = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
            if (dStartA && !dEndA && dStartA > threeMonthsFromNow && divisor > 1) {
                // startDate is actually the end date
                endDate = startDate;
                const computedStart = new Date(dStartA);
                computedStart.setMonth(computedStart.getMonth() - divisor);
                startDate = toDDMMYYYY(computedStart);
                console.log('[date-fix] end_date found in start field, reconstructed start:', startDate, 'end:', endDate);
            }

            // Fix 3: end missing or same as start → add divisor months to start
            const dStartB = safeDate(startDate);
            const dEndB   = safeDate(endDate);
            if (dStartB && (!dEndB || dStartB.getTime() === dEndB?.getTime()) && divisor > 1) {
                const computed = new Date(dStartB);
                computed.setMonth(computed.getMonth() + divisor);
                endDate = toDDMMYYYY(computed);
                console.log('[date-fix] computed end from contract length:', endDate);
            }

            // Fix 4: perm date identical to start (LLM error) → set to end date
            if (permDate && permDate === startDate && endDate && endDate !== startDate) {
                permDate = endDate;
            }

            const parsed = {
                title:                (raw.title || '').substring(0, 40),
                category:             raw.category     || 'Other',
                monthly_cost:         monthlyCost,
                billing_cycle:        raw.billing_cycle || 'Monthly',
                start_date:           startDate,
                contract_end_date:    endDate,
                permanencia_end_date: permDate,
                notes:                raw.notes || '',
            };

            console.log('[analyze] monthly_cost computed:', costValue, '÷', divisor, '=', monthlyCost);
            console.log('[analyze] notes preview:', (raw.notes || '(empty)').substring(0, 120));
            console.log('[analyze] billing_cycle:', parsed.billing_cycle, '| category:', parsed.category);
            res.json(parsed);

        } catch (e) {
            console.error('AI analysis error:', e);
            res.status(500).json({ error: 'AI analysis failed: ' + e.message });
        }
    });
});

// ─── FILE SYSTEM UTILITIES ──────────────────────────────────────────
function sanitizePath(str) {
    if (!str) return 'Untitled';
    return String(str).replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_').trim();
}

function moveAndRenameFile(tempPath, category, title, originalName) {
    if (!tempPath || !fs.existsSync(tempPath)) return null;
    
    // Use translated category name for the actual physical folder
    const translatedCat = getTranslatedCategoryName(category || 'Other');
    const cat = sanitizePath(translatedCat);
    const t = sanitizePath(title || 'Untitled');
    const targetDir = path.join(CONTRACTS_DIR, cat, t);
    
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const ext = path.extname(originalName) || '.pdf';
    let newFilename = `${t}${ext}`;
    let newPath = path.join(targetDir, newFilename);
    
    let counter = 2;
    while (fs.existsSync(newPath)) {
        newFilename = `${t}_${counter}${ext}`;
        newPath = path.join(targetDir, newFilename);
        counter++;
    }

    fs.renameSync(tempPath, newPath);
    return `Contracts/${cat}/${t}/${newFilename}`;
}

// 鈹€鈹€鈹€ CONTRACTS API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
app.get('/api/contracts', (req, res) => {
    db.all(`SELECT * FROM contracts ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/contracts/:id', (req, res) => {
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    });
});

app.post('/api/contracts', upload.single('document'), (req, res) => {
    const { title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes } = req.body;
    let file_path = null;
    if (req.file) {
        file_path = moveAndRenameFile(req.file.path, category, title, req.file.originalname);
    }
    if (!title) return res.status(400).json({ error: 'Title is required' });

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
            console.log("DB INSERT SUCCESS:", this.lastID);
            res.json({ id: this.lastID, title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes, file_path });
        }
    );
});

app.put('/api/contracts/:id', upload.single('document'), (req, res) => {
    const { title, category, monthly_cost, billing_cycle, start_date, contract_end_date, permanencia_end_date, notes } = req.body;
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        
        let file_path = row.file_path;
        if (req.file) {
            file_path = moveAndRenameFile(req.file.path, category || row.category, title || row.title, req.file.originalname);
        } else if ((title && title !== row.title) || (category && category !== row.category)) {
            // User renamed contract or changed category, move the folder
            const oldCat = sanitizePath(row.category || 'Other');
            const oldTitle = sanitizePath(row.title);
            const newCat = sanitizePath(category || row.category || 'Other');
            const newTitle = sanitizePath(title || row.title);
            
            const oldDir = path.join(CONTRACTS_DIR, oldCat, oldTitle);
            const newDir = path.join(CONTRACTS_DIR, newCat, newTitle);
            
            if (fs.existsSync(oldDir) && oldDir !== newDir) {
                if (!fs.existsSync(path.join(CONTRACTS_DIR, newCat))) {
                    fs.mkdirSync(path.join(CONTRACTS_DIR, newCat), { recursive: true });
                }
                fs.renameSync(oldDir, newDir);
                if (file_path && file_path.startsWith('Contracts/')) {
                    file_path = `Contracts/${newCat}/${newTitle}/${path.basename(file_path)}`;
                }
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
                res.json({ id: req.params.id, updated: true });
            }
        );
    });
});

app.delete('/api/contracts/:id', (req, res) => {
    db.get(`SELECT * FROM contracts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        
        const cat = sanitizePath(row.category || 'Other');
        const title = sanitizePath(row.title);
        const targetDir = path.join(CONTRACTS_DIR, cat, title);
        
        try {
            if (fs.existsSync(targetDir)) {
                fs.rmSync(targetDir, { recursive: true, force: true });
            } else if (row.file_path) {
                const absPath = path.join(DATA_DIR, row.file_path);
                if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath); // legacy fallback
                }
            }
        } catch (e) {
            console.error('Warning: Could not delete contract files:', e.message);
        }
        
        db.run(`DELETE FROM contracts WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: true });
        });
    });
});

// 鈹€鈹€鈹€ BACKUP 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
app.get('/api/export', (req, res) => {
    res.attachment('xeck_backup.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).send({ error: err.message }));
    archive.pipe(res);
    archive.file(DB_FILE, { name: 'contracts.db' });
    archive.directory(UPLOADS_DIR, 'uploads'); // Keep for legacy files
    if (fs.existsSync(CONTRACTS_DIR)) archive.directory(CONTRACTS_DIR, 'Contracts'); // New structure
    archive.finalize();
});

app.post('/api/import', importUpload.single('backup'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No backup file provided.' });
    db.close(err => {
        if (err) return res.status(500).json({ error: 'Failed to close DB' });
        try {
            new AdmZip(req.file.path).extractAllTo(DATA_DIR, true);
            fs.unlinkSync(req.file.path);
            connectDB();
            res.json({ message: 'Backup imported!' });
        } catch (e) {
            connectDB();
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
            'https://www.googleapis.com/auth/drive.file'
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
                const fileName = path.basename(c.file_path);

                // Create folder hierarchy
                const catId = await getOrCreateFolder(drive, cat, rootId);
                const titleId = await getOrCreateFolder(drive, title, catId);

                // Find file by name under Xeck_Contracts recursively (searching for previous locations)
                const searchRes = await drive.files.list({
                    q: `name = '${fileName}' and trashed = false`,
                    fields: 'files(id, parents)'
                });

                let cloudFileId = null;
                let currentParentId = null;

                if (searchRes.data.files.length > 0) {
                    cloudFileId = searchRes.data.files[0].id;
                    currentParentId = (searchRes.data.files[0].parents || [])[0];
                }

                if (cloudFileId) {
                    // If file exists but in WRONG folder (category changed), MOVE it
                    if (currentParentId !== titleId) {
                        console.log(`[Sync] Moving ${fileName} on Drive: from ${currentParentId} to ${titleId}`);
                        await drive.files.update({
                            fileId: cloudFileId,
                            addParents: titleId,
                            removeParents: currentParentId,
                            fields: 'id, parents'
                        });
                    }
                } else {
                    // Upload new file
                    const absPath = path.join(DATA_DIR, c.file_path);
                    if (fs.existsSync(absPath)) {
                        console.log(`[Sync] Uploading ${fileName} to Drive at ${cat}/${title}...`);
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

const server = app.listen(0, async () => {
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
module.exports = { app, server, authBus };

