const express = require('express');
const { Pool } = require('pg'); // Changed from sqlite3
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();

// --- POSTGRES CONNECTION ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cors());

// --- DATABASE INITIALIZATION ---
const initDb = async () => {
    try {
        // Tickets Table
        await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Rescuers Table
        await pool.query(`CREATE TABLE IF NOT EXISTS rescuers (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            badge_id TEXT UNIQUE NOT NULL,
            callsign TEXT, 
            phone TEXT,
            password TEXT NOT NULL,
            profile_image BYTEA,
            status TEXT DEFAULT 'available',
            last_lat REAL,
            last_lon REAL
        )`);

        // Handle ALTERS (In case table exists)
        await pool.query("ALTER TABLE rescuers ADD COLUMN IF NOT EXISTS callsign TEXT").catch(() => {});
        await pool.query("ALTER TABLE rescuers ADD COLUMN IF NOT EXISTS last_lat REAL").catch(() => {});
        await pool.query("ALTER TABLE rescuers ADD COLUMN IF NOT EXISTS last_lon REAL").catch(() => {});

        // Messages Table
        await pool.query(`CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            ticket_number TEXT,
            sender TEXT,
            message TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        console.log("PostgreSQL Database Initialized Successfully");
    } catch (err) {
        console.error("Database Init Error:", err);
    }
};
initDb();

// --- ROUTES ---

// 1. REGISTER NEW RESCUER
app.post('/api/rescuers', upload.single('profile_image'), async (req, res) => {
    try {
        const { name, badge_id, callsign, phone, password } = req.body;
        const imageBuffer = req.file ? req.file.buffer : null;
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `INSERT INTO rescuers (name, badge_id, callsign, phone, password, profile_image) 
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        
        const result = await pool.query(sql, [name, badge_id, callsign, phone, hashedPassword, imageBuffer]);
        res.json({ message: "Account created successfully", id: result.rows[0].id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Badge ID exists or Database Error" });
    }
});

app.get('/api/rescuers', async (req, res) => {
    const sql = "SELECT id, name, badge_id, callsign, phone, status FROM rescuers WHERE status != 'off-duty'";
    try {
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rescuers/locations', async (req, res) => {
    const sql = "SELECT id, name, last_lat, last_lon, status, callsign FROM rescuers WHERE last_lat IS NOT NULL AND status != 'off-duty'";
    try {
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. GET RESCUER IMAGE
app.get('/api/rescuers/image/:id', async (req, res) => {
    const sql = "SELECT profile_image FROM rescuers WHERE id = $1";
    try {
        const result = await pool.query(sql, [req.params.id]);
        if (result.rows.length === 0 || !result.rows[0].profile_image) {
            return res.status(404).send("Image not found");
        }
        res.contentType('image/jpeg'); 
        res.send(result.rows[0].profile_image);
    } catch (err) {
        res.status(500).send("Error fetching image");
    }
});

// 4. SOS TICKET ROUTES
app.post('/api/ticket', async (req, res) => {
    const { ticket_number, service, name, phone, lat, lon, details } = req.body;
    const query = `INSERT INTO tickets (ticket_number, service_type, user_name, phone, latitude, longitude, incident_details) 
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
    
    try {
        const result = await pool.query(query, [ticket_number, service, name, phone, lat, lon, details]);
        res.json({ message: "Ticket saved", id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tickets', async (req, res) => {
    const query = `SELECT * FROM tickets WHERE status != 'SOLVED' ORDER BY created_at DESC`;
    try {
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. DISPATCH/ASSIGNMENT LOGIC (Transaction style)
app.post('/api/ticket/assign', async (req, res) => {
    const { ticketId, rescuerId, rescuerName } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const updateTicket = "UPDATE tickets SET rescuer_id = $1, rescuer_name = $2, status = 'DISPATCHED' WHERE id = $3";
        await client.query(updateTicket, [rescuerId, rescuerName, ticketId]);
        
        const updateRescuer = "UPDATE rescuers SET status = 'on-mission' WHERE id = $1";
        await client.query(updateRescuer, [rescuerId]);
        
        await client.query('COMMIT');
        res.json({ success: true, message: "Unit dispatched!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Update failed" });
    } finally {
        client.release();
    }
});

// 6. SOLVE TICKET
app.post('/api/ticket/solve/:id', async (req, res) => {
    try {
        await pool.query(`UPDATE tickets SET status = 'SOLVED' WHERE id = $1`, [req.params.id]);
        res.json({ message: "Ticket marked as solved" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check ticket status
app.get('/api/ticket/status/:ticket_number', async (req, res) => {
    const sql = "SELECT status, rescuer_name FROM tickets WHERE ticket_number = $1";
    try {
        const result = await pool.query(sql, [req.params.ticket_number]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Ticket not found" });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Rescuer Location
app.post('/api/rescuer/location', async (req, res) => {
    const { rescuerId, lat, lon } = req.body;
    
    try {
        const checkMission = "SELECT id FROM tickets WHERE rescuer_id = $1 AND status = 'DISPATCHED'";
        const missionResult = await pool.query(checkMission, [rescuerId]);
        
        let newStatus = missionResult.rows.length > 0 ? 'responding' : 'available';
        
        const sql = `UPDATE rescuers SET last_lat = $1, last_lon = $2, status = $3 WHERE id = $4`;
        await pool.query(sql, [lat, lon, newStatus, rescuerId]);
        res.json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rescuer Login
app.post('/api/rescuer/login', async (req, res) => {
    const { badge_id, password } = req.body;
    const sql = "SELECT * FROM rescuers WHERE badge_id = $1";
    
    try {
        const result = await pool.query(sql, [badge_id]);
        const rescuer = result.rows[0];

        if (!rescuer) return res.status(401).json({ error: "Auth Failed" });
        
        const match = await bcrypt.compare(password, rescuer.password);
        if (match) {
            await pool.query("UPDATE rescuers SET status = 'available' WHERE id = $1", [rescuer.id]);
            res.json(rescuer);
        } else {
            res.status(401).json({ error: "Auth Failed" });
        }
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.post('/api/rescuer/logout', async (req, res) => {
    const { rescuerId } = req.body;
    try {
        await pool.query("UPDATE rescuers SET status = 'off-duty' WHERE id = $1", [rescuerId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE Rescuer
app.delete('/api/rescuers/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM rescuers WHERE id = $1", [req.params.id]);
        res.json({ message: "Rescuer deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// UPDATE Rescuer
app.put('/api/rescuers/:id', upload.single('profile_image'), async (req, res) => {
    const { name, badge_id, callsign, phone } = req.body;
    const imageBuffer = req.file ? req.file.buffer : null;

    try {
        let sql, params;
        if (imageBuffer) {
            sql = `UPDATE rescuers SET name=$1, badge_id=$2, callsign=$3, phone=$4, profile_image=$5 WHERE id=$6`;
            params = [name, badge_id, callsign, phone, imageBuffer, req.params.id];
        } else {
            sql = `UPDATE rescuers SET name=$1, badge_id=$2, callsign=$3, phone=$4 WHERE id=$5`;
            params = [name, badge_id, callsign, phone, req.params.id];
        }
        await pool.query(sql, params);
        res.json({ message: "Updated successfully" });
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

// Send Message
app.post('/api/chat/send', async (req, res) => {
    const { ticket_number, sender, message } = req.body;
    const sql = `INSERT INTO messages (ticket_number, sender, message) VALUES ($1, $2, $3) RETURNING id`;
    try {
        const result = await pool.query(sql, [ticket_number, sender, message]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Messages
app.get('/api/chat/:ticket_number', async (req, res) => {
    const sql = `SELECT * FROM messages WHERE ticket_number = $1 ORDER BY timestamp ASC`;
    try {
        const result = await pool.query(sql, [req.params.ticket_number]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
