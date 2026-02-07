const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const db = new sqlite3.Database('./emergency.db');

// --- SETUP MULTER FOR BLOB (Memory Storage) ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use(express.static('public'));

// --- DATABASE INITIALIZATION ---
db.serialize(() => {
    // Tickets Table
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_number TEXT,
        service_type TEXT,
        user_name TEXT,
        phone TEXT,
        latitude REAL,
        longitude REAL,
        incident_details TEXT,
        rescuer_id INTEGER,
        rescuer_name TEXT,
        status TEXT DEFAULT 'ACTIVE',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // UPDATED Rescuers Table with all columns
    db.run(`CREATE TABLE IF NOT EXISTS rescuers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        badge_id TEXT UNIQUE NOT NULL,
        callsign TEXT, 
        phone TEXT,
        password TEXT NOT NULL,
        profile_image BLOB,
        status TEXT DEFAULT 'available',
        last_lat REAL,
        last_lon REAL
    )`);

    // Ensure columns exist if table was created by the old code
    db.run("ALTER TABLE rescuers ADD COLUMN callsign TEXT", (err) => {});
    db.run("ALTER TABLE rescuers ADD COLUMN last_lat REAL", (err) => {});
    db.run("ALTER TABLE rescuers ADD COLUMN last_lon REAL", (err) => {});

    db.run("PRAGMA foreign_keys = ON");

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_number TEXT,
        sender TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- ROUTES ---

// 1. REGISTER NEW RESCUER (BLOB & Hashed Password)
app.post('/api/rescuers', upload.single('profile_image'), async (req, res) => {
    try {
        const { name, badge_id, callsign, phone, password } = req.body; // Added callsign
        const imageBuffer = req.file ? req.file.buffer : null;
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `INSERT INTO rescuers (name, badge_id, callsign, phone, password, profile_image) 
                     VALUES (?, ?, ?, ?, ?, ?)`; // Added placeholder
        
        db.run(sql, [name, badge_id, callsign, phone, hashedPassword, imageBuffer], function(err) {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: "Badge ID exists or Database Error" });
            }
            res.json({ message: "Account created successfully", id: this.lastID });
        });
    } catch (error) {
        res.status(500).json({ error: "Server error during registration" });
    }
});

// Update GET /api/rescuers to include callsign in the selection
app.get('/api/rescuers', (req, res) => {
    const sql = "SELECT id, name, badge_id, callsign, phone, status FROM rescuers WHERE status != 'off-duty'";
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add this to your server.js
app.get('/api/rescuers/locations', (req, res) => {
    // Select rescuers who have location data and are not off-duty
    const sql = "SELECT id, name, last_lat, last_lon, status, callsign FROM rescuers WHERE last_lat IS NOT NULL AND status != 'off-duty'";
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 3. GET RESCUER IMAGE (Serves the BLOB)
app.get('/api/rescuers/image/:id', (req, res) => {
    const sql = "SELECT profile_image FROM rescuers WHERE id = ?";
    db.get(sql, [req.params.id], (err, row) => {
        if (err || !row || !row.profile_image) {
            return res.status(404).send("Image not found");
        }
        res.contentType('image/jpeg'); 
        res.send(row.profile_image);
    });
});

// 4. SOS TICKET ROUTES
app.post('/api/ticket', (req, res) => {
    const { ticket_number, service, name, phone, lat, lon, details } = req.body;
    const query = `INSERT INTO tickets (ticket_number, service_type, user_name, phone, latitude, longitude, incident_details) 
                   VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [ticket_number, service, name, phone, lat, lon, details], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Ticket saved", id: this.lastID });
    });
});

app.get('/api/tickets', (req, res) => {
    const query = `SELECT * FROM tickets WHERE status != 'SOLVED' ORDER BY created_at DESC`;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 5. DISPATCH/ASSIGNMENT LOGIC
app.post('/api/ticket/assign', (req, res) => {
    const { ticketId, rescuerId, rescuerName } = req.body;
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const updateTicket = "UPDATE tickets SET rescuer_id = ?, rescuer_name = ?, status = 'DISPATCHED' WHERE id = ?";
        db.run(updateTicket, [rescuerId, rescuerName, ticketId], (err) => {
            if (err) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: "Update failed" });
            }
            const updateRescuer = "UPDATE rescuers SET status = 'on-mission' WHERE id = ?";
            db.run(updateRescuer, [rescuerId], (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: "Status update failed" });
                }
                db.run("COMMIT", (err) => {
                    if (err) return res.status(500).json({ error: "Commit error" });
                    res.json({ success: true, message: "Unit dispatched!" });
                });
            });
        });
    });
});

// 6. SOLVE TICKET
app.post('/api/ticket/solve/:id', (req, res) => {
    const id = req.params.id;
    db.run(`UPDATE tickets SET status = 'SOLVED' WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Ticket marked as solved" });
    });
});

// NEW ROUTE: Check ticket status for the user polling
app.get('/api/ticket/status/:ticket_number', (req, res) => {
    const ticketNumber = req.params.ticket_number;
    const sql = "SELECT status, rescuer_name FROM tickets WHERE ticket_number = ?";
    
    db.get(sql, [ticketNumber], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Ticket not found" });
        }
        res.json(row);
    });
});

// Update Rescuer Location
app.post('/api/rescuer/location', (req, res) => {
    const { rescuerId, lat, lon } = req.body;
    db.run("UPDATE rescuers SET last_lat = ?, last_lon = ? WHERE id = ?", [lat, lon, rescuerId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Rescuer Login
app.post('/api/rescuer/login', (req, res) => {
    const { badge_id, password } = req.body;
    db.get("SELECT * FROM rescuers WHERE badge_id = ?", [badge_id], async (err, rescuer) => {
        if (err || !rescuer) return res.status(401).json({ error: "Invalid Credentials" });
        
        const match = await bcrypt.compare(password, rescuer.password);
        if (!match) return res.status(401).json({ error: "Invalid Credentials" });
        
        res.json({ id: rescuer.id, name: rescuer.name, status: rescuer.status });
    });
});

// DELETE Rescuer
app.delete('/api/rescuers/:id', (req, res) => {
    db.run("DELETE FROM rescuers WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Rescuer deleted successfully" });
    });
});

// UPDATE Rescuer (Basic Info)
app.put('/api/rescuers/:id', upload.single('profile_image'), async (req, res) => {
    const { name, badge_id, callsign, phone } = req.body;
    const imageBuffer = req.file ? req.file.buffer : null;

    let sql, params;
    if (imageBuffer) {
        sql = `UPDATE rescuers SET name=?, badge_id=?, callsign=?, phone=?, profile_image=? WHERE id=?`;
        params = [name, badge_id, callsign, phone, imageBuffer, req.params.id];
    } else {
        sql = `UPDATE rescuers SET name=?, badge_id=?, callsign=?, phone=? WHERE id=?`;
        params = [name, badge_id, callsign, phone, req.params.id];
    }

    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: "Update failed" });
        res.json({ message: "Updated successfully" });
    });
});

// Send Message
app.post('/api/chat/send', (req, res) => {
    const { ticket_number, sender, message } = req.body;
    const sql = `INSERT INTO messages (ticket_number, sender, message) VALUES (?, ?, ?)`;
    db.run(sql, [ticket_number, sender, message], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// Get Messages for a ticket
app.get('/api/chat/:ticket_number', (req, res) => {
    const sql = `SELECT * FROM messages WHERE ticket_number = ? ORDER BY timestamp ASC`;
    db.all(sql, [req.params.ticket_number], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`SOS Server running at http://localhost:${PORT}`);
});
