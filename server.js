const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database(path.join(__dirname, 'database.db'));

// Middleware Configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'aurobindo_chess_luxury_secret_2026_prod',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Render HTTP/HTTPS दोनों पर सही काम करने के लिए false रखें
        maxAge: 1000 * 60 * 60 * 24 // 24 Hours Session
    }
}));

// Initialize Database & Automate Tables Creation
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS AllowedEmails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS Users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT,
        approved BOOLEAN,
        photo TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS Content (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        homepage_text TEXT,
        about_text TEXT,
        contact_info TEXT,
        images TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS Attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        status TEXT,
        FOREIGN KEY(user_id) REFERENCES Users(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS Games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        result TEXT, -- win, loss, draw
        accuracy REAL,
        date TEXT,
        FOREIGN KEY(user_id) REFERENCES Users(id) ON DELETE CASCADE
    )`);

    // Dynamic Default Settings Insertion
    db.run(`INSERT OR IGNORE INTO AllowedEmails (email) VALUES ('admin@aurobindo.com')`);
    db.run(`INSERT OR IGNORE INTO AllowedEmails (email) VALUES ('student@aurobindo.com')`);
    
    // Default Admin Account Creation (Password: admin123)
    db.get(`SELECT * FROM Users WHERE email = 'admin@aurobindo.com'`, async (err, row) => {
        if (!row) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO Users (name, email, password, role, approved, photo) 
                    VALUES ('Aurobindo Admin', 'admin@aurobindo.com', ?, 'admin', 1, 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=100')`, [hashedPassword]);
        }
    });

    // Default Academy Content Setup
    db.get(`SELECT * FROM Content WHERE id = 1`, (err, row) => {
        if (!row) {
            db.run(`INSERT INTO Content (id, homepage_text, about_text, contact_info, images) VALUES (1, 
                'Welcome to India''s Premier Chess Academy. Shaping Grandmasters of tomorrow.', 
                'Aurobindo Chess Academy provides world-class training under professional instructors with state-of-the-art infrastructure.',
                'Address: 98/C, Raja Rammohan Roy Sarani, Serampore, West Bengal 712203 | Phone: +91 98366 16464', '{}')`);
        }
    });
});

// Authentication and Route Protection Middlewares
const isAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    res.status(401).json({ error: "Unauthorized. Please login first." });
};

// Routing Strategy - Root Rule Implementation
app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/admin.html' : '/dashboard.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin.html', (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.redirect('/');
}, express.static(path.join(__dirname, 'public')));

app.get('/dashboard.html', (req, res, next) => {
    if (req.session.user && req.session.user.role === 'student') return next();
    res.redirect('/');
}, express.static(path.join(__dirname, 'public')));

app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTHENTICATION API ====================

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, photo } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    
    db.get(`SELECT * FROM AllowedEmails WHERE email = ?`, [cleanEmail], async (err, allowed) => {
        if (err) return res.status(500).json({ error: "Database error." });
        if (!allowed) return res.status(400).json({ error: "Your email is not pre-approved by the academy management." });

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const userPhoto = photo || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=100';
            
            db.run(`INSERT INTO Users (name, email, password, role, approved, photo) VALUES (?, ?, ?, 'student', 0, ?)`, 
            [name, cleanEmail, hashedPassword, userPhoto], function(err) {
                if (err) return res.status(400).json({ error: "This email is already registered." });
                res.json({ success: "Registration request submitted successfully! Waiting for admin approval." });
            });
        } catch (e) {
            res.status(500).json({ error: "Encryption error." });
        }
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    
    db.get(`SELECT * FROM Users WHERE email = ?`, [cleanEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: "Database failure." });
        if (!user) return res.status(400).json({ error: "Invalid Email or Password." });
        if (!user.approved) return res.status(403).json({ error: "Your registration is pending admin approval." });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Invalid Email or Password." });

        req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, photo: user.photo };
        res.json({ success: true, redirect: user.role === 'admin' ? '/admin.html' : '/dashboard.html' });
    });
});

app.get('/api/auth/session', isAuthenticated, (req, res) => {
    res.json(req.session.user);
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// ==================== ADMIN CORE API ====================

// Website Editor Routes
app.get('/api/admin/content', isAuthenticated, (req, res) => {
    db.get(`SELECT * FROM Content WHERE id = 1`, (err, content) => {
        res.json(content || {});
    });
});

app.post('/api/admin/content', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const { homepage_text, about_text, contact_info } = req.body;
    db.run(`UPDATE Content SET homepage_text = ?, about_text = ?, contact_info = ? WHERE id = 1`,
        [homepage_text, about_text, contact_info], function(err) {
            if (err) return res.status(500).json({ error: "Failed to update content." });
            res.json({ success: "Website configuration saved successfully!" });
        }
    );
});

// Allowed Emails Management
app.get('/api/admin/allowed-emails', isAuthenticated, (req, res) => {
    db.all(`SELECT * FROM AllowedEmails ORDER BY id DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/allowed-emails', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const email = req.body.email.trim().toLowerCase();
    db.run(`INSERT OR IGNORE INTO AllowedEmails (email) VALUES (?)`, [email], function(err) {
        if (err) return res.status(500).json({ error: "Error pre-authorizing email." });
        res.json({ success: "Email added to pre-approved academy list." });
    });
});

app.delete('/api/admin/allowed-emails/:id', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    db.run(`DELETE FROM AllowedEmails WHERE id = ?`, [req.params.id], function(err) {
        res.json({ success: "Pre-approved email removed." });
    });
});

// Student Management (Approve/Reject/Edit/Delete)
app.get('/api/admin/students', isAuthenticated, (req, res) => {
    db.all(`SELECT id, name, email, role, approved, photo FROM Users WHERE role = 'student' ORDER BY id DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/students/action', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const { studentId, action } = req.body; // action: 'approve', 'reject', 'delete'
    
    if (action === 'approve') {
        db.run(`UPDATE Users SET approved = 1 WHERE id = ?`, [studentId], () => res.json({ success: "Student approved!" }));
    } else if (action === 'reject' || action === 'delete') {
        db.run(`DELETE FROM Users WHERE id = ?`, [studentId], () => res.json({ success: "Student record updated." }));
    } else {
        res.status(400).json({ error: "Invalid operation." });
    }
});

// Attendance Management System
app.post('/api/admin/attendance', isAuthenticated, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const { date, records } = req.body; // records: [{user_id, status}]
    
    db.serialize(() => {
        records.forEach(rec => {
            db.run(`INSERT INTO Attendance (user_id, date, status) VALUES (?, ?, ?)`, [rec.user_id, date, rec.status]);
        });
    });
    res.json({ success: "Attendance logged successfully!" });
});

app.get('/api/admin/attendance-logs', isAuthenticated, (req, res) => {
    db.all(`SELECT a.id, u.name, a.date, a.status FROM Attendance a JOIN Users u ON a.user_id = u.id ORDER BY a.date DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

// Performance Metric Engine & Ranking Analytics
app.get('/api/admin/rankings', isAuthenticated, (req, res) => {
    const query = `
        SELECT u.id, u.name, u.photo,
        COUNT(g.id) as total_matches,
        SUM(CASE WHEN g.result = 'win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN g.result = 'draw' THEN 1 ELSE 0 END) as draws,
        SUM(CASE WHEN g.result = 'loss' THEN 1 ELSE 0 END) as losses,
        AVG(g.accuracy) as avg_accuracy
        FROM Users u
        LEFT JOIN Games g ON u.id = g.user_id
        WHERE u.role = 'student' AND u.approved = 1
        GROUP BY u.id
    `;
    
    db.all(query, (err, rows) => {
        if (err) return res.status(500).json({ error: "Ranking Engine failure." });
        
        // Calculate SaaS score based on strict core rule
        let rankedStudents = rows.map(s => {
            const wins = s.wins || 0;
            const draws = s.draws || 0;
            const accuracy = s.avg_accuracy || 0;
            const calculatedScore = (wins * 3) + (draws * 1) + (accuracy * 0.1);
            return {
                ...s,
                accuracy: accuracy.toFixed(1),
                score: calculatedScore.toFixed(2)
            };
        });

        // Top 10 Dynamic Sort Sorting
        rankedStudents.sort((a, b) => b.score - a.score);
        res.json(rankedStudents.slice(0, 10));
    });
});

// ==================== STUDENT DASHBOARD CORE API ====================

app.get('/api/student/stats', isAuthenticated, (req, res) => {
    const studentId = req.session.user.id;
    
    const gameQuery = `SELECT COUNT(*) as total, 
                       SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
                       SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
                       AVG(accuracy) as accuracy FROM Games WHERE user_id = ?`;
                       
    const attQuery = `SELECT COUNT(*) as total,
                      SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) as present FROM Attendance WHERE user_id = ?`;

    db.get(gameQuery, [studentId], (err, gameStats) => {
        db.get(attQuery, [studentId], (err, attStats) => {
            const totalAttendance = attStats.total || 1;
            const presentCount = attStats.present || 0;
            const attendancePct = ((presentCount / totalAttendance) * 100).toFixed(1);

            res.json({
                matches: gameStats.total || 0,
                wins: gameStats.wins || 0,
                losses: gameStats.losses || 0,
                accuracy: gameStats.accuracy ? gameStats.accuracy.toFixed(1) : "0.0",
                attendance: attendancePct
            });
        });
    });
});

app.post('/api/student/game', isAuthenticated, (req, res) => {
    const { result, accuracy } = req.body;
    const studentId = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];

    db.run(`INSERT INTO Games (user_id, result, accuracy, date) VALUES (?, ?, ?, ?)`,
        [studentId, result, accuracy, today], function(err) {
            if (err) return res.status(500).json({ error: "Failed to persist match outcome." });
            res.json({ success: "Match outcome recorded securely." });
        }
    );
});

// ==================== HIGH-END PDF GENERATION ENGINE ====================

app.get('/api/reports/download-pdf', isAuthenticated, (req, res) => {
    const studentId = req.session.user.id;
    
    db.get(`SELECT name, email FROM Users WHERE id = ?`, [studentId], (err, user) => {
        if (!user) return res.status(404).send("User routing missing.");

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Aurobindo_Academy_Report.pdf`);
        doc.pipe(res);

        // Styling the PDF Document (Premium Gold & Slate theme)
        doc.rect(0, 0, 612, 120).fill('#0f172a');
        doc.fillColor('#facc15').fontSize(26).text('AUROBINDO CHESS ACADEMY', 50, 40, { align: 'center', tracking: 2 });
        doc.fillColor('#94a3b8').fontSize(10).text('98/C, Raja Rammohan Roy Sarani, Serampore, West Bengal 712203', 50, 75, { align: 'center' });

        doc.moveDown(5);
        doc.fillColor('#1e293b').fontSize(18).text('OFFICIAL PERFORMANCE REPORT', { underline: true });
        doc.moveDown(1);
        doc.fontSize(12).fillColor('#334155');
        doc.text(`Student Name :  ${user.name}`);
        doc.text(`Registered Email :  ${user.email}`);
        doc.text(`Date of Generation :  ${new Date().toLocaleDateString()}`);
        doc.moveDown(2);

        // Add Table Headers for Stats
        doc.rect(50, doc.y, 500, 25).fill('#1e293b');
        doc.fillColor('#ffffff').fontSize(11).text('Metric Assessment', 60, doc.y - 18);
        doc.text('Status / Value', 400, doc.y - 18);
        
        // Fetch stats dynamically to print inside PDF
        db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins, AVG(accuracy) as acc FROM Games WHERE user_id = ?`, [studentId], (err, g) => {
            doc.moveDown(1);
            doc.fillColor('#000000');
            doc.text(`Total Matches Played:`, 60);
            doc.text(`${g.total || 0}`, 400);
            
            doc.moveDown(1);
            doc.text(`Total Victories (Wins):`, 60);
            doc.text(`${g.wins || 0}`, 400);

            doc.moveDown(1);
            doc.text(`Engine Play Accuracy:`, 60);
            doc.text(`${g.acc ? g.acc.toFixed(1) : '0.0'}%`, 400);

            // Footer Signoff
            doc.moveDown(4);
            doc.fillColor('#64748b').fontSize(10).text('Authorized electronic certificate from Aurobindo Chess Academy Administration.', { align: 'center', italic: true });
            doc.end();
        });
    });
});

app.listen(PORT, () => console.log(`🚀 Premium SaaS Engine running live on port ${PORT}`));
      
