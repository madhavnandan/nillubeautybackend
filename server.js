import express from 'express';
import bodyParser from 'body-parser';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs/promises';
dotenv.config();
import cors from 'cors';

const app = express();
app.use(bodyParser.json());


app.use(cors({
  origin: 'http://localhost:5173', // your frontend URL
  credentials: true
}));

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const DB_NAME = process.env.DB_NAME || 'nillu_parlour';
const JWT_SECRET = process.env.JWT_SECRET || 'replace_me';

let db;

async function initDb() {
  // 1️⃣ Create connection WITHOUT specifying database
  const rootConn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
  });

  // 2️⃣ Create database if not exists (no extra backslashes!)
  await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  console.log(`✅ Database ensured: ${DB_NAME}`);

  // 3️⃣ Close temporary root connection
  await rootConn.end();

  // 4️⃣ Connect to the actual database
  db = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    multipleStatements: true,
  });

  // 5️⃣ Create tables (if not exist)
  const createSql = await fs.readFile('./create_tables.sql', 'utf8');
  await db.query(createSql);
  console.log('✅ Tables checked/created.');

  // 6️⃣ Ensure admin user exists
  const [rows] = await db.execute('SELECT COUNT(*) as cnt FROM users');
  if (rows[0].cnt === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.execute(
      'INSERT INTO users (username,password_hash,role) VALUES (?,?,?)',
      ['admin', hash, 'admin']
    );
    console.log('👤 Created default admin -> username: admin  password: admin123');
  }
}

await initDb();

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: 'missing token' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'invalid token' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ---------- AUTH ----------
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
  if (rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// ---------- PRODUCTS ----------
app.get('/api/products', authMiddleware, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM products');
  res.json(rows);
});

app.post('/api/products', authMiddleware, async (req, res) => {
  const { name, sku, stock, cost_price, sell_price } = req.body;

  const [result] = await db.execute(
    'INSERT INTO products (name,sku,stock,cost_price,sell_price) VALUES (?,?,?,?,?)',
    [name, sku || '', stock || 0, cost_price || 0, sell_price || 0]
  );

  const productId = result.insertId;

  // 1️⃣ Add transaction for stock addition
  if (Number(stock) > 0) {
    await db.execute(
      'INSERT INTO transactions (type,t_type, details, amount, cost, notes) VALUES (?, ?, ?, ?, ?,?)',
      [
        'expense',
        'DR', // Debit for adding stock
        JSON.stringify({ product_id: productId, quantity: stock }),
        0, // No revenue for stock addition
        Number(cost_price) * Number(stock), // Total cost of added stock
        `Added ${stock} units of ${name}`
      ]
    );
  }

  res.json({ id: productId });
});


app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { name, sku, stock, cost_price, sell_price } = req.body;
  await db.execute(
    'UPDATE products SET name=?,sku=?,stock=?,cost_price=?,sell_price=? WHERE id=?',
    [name, sku || '', stock || 0, cost_price || 0, sell_price || 0, id]
  );
  res.json({ success: true });
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  await db.execute('DELETE FROM products WHERE id=?', [id]);
  res.json({ success: true });
});

// ---------- SERVICES ----------
app.get('/api/services', authMiddleware, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM services');
  res.json(rows);
});

app.post('/api/services', authMiddleware, async (req, res) => {
  const { name, description, price, cost } = req.body;
  const [result] = await db.execute(
    'INSERT INTO services (name,description,price,cost) VALUES (?,?,?,?)',
    [name, description || '', price || 0, cost || 0]
  );
  res.json({ id: result.insertId });
});



// ---------- PROFIT & LOSS ----------
app.get('/api/reports/pl', authMiddleware, async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2099-12-31';

  const [rows] = await db.execute(
    'SELECT * FROM transactions WHERE date BETWEEN ? AND ?',
    [`${from} 00:00:00`, `${to} 23:59:59`]
  );

  let revenue = 0, cost = 0;
  rows.forEach(tx => {
    revenue += parseFloat(tx.amount);
    cost += parseFloat(tx.cost || 0);
  });

  res.json({
    revenue,
    cost,
    profit: revenue - cost,
    transactionsCount: rows.length
  });
});


// ---------- PRODUCT SALE ----------
app.post('/api/sales/sell', authMiddleware, async (req, res) => {
  const { product_id, quantity, customer_name, selling_price } = req.body;

  if (!product_id || !quantity || !selling_price) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // fetch product
  const [[product]] = await db.execute("SELECT * FROM products WHERE id=?", [product_id]);
  if (!product) return res.status(404).json({ error: "Product not found" });

  if (product.stock < quantity) {
    return res.status(400).json({ error: "Not enough stock" });
  }

  const total_amount = selling_price * quantity;
  const total_cost = product.cost_price * quantity;

  // record transaction
  await db.execute(
    `INSERT INTO transactions (type,t_type, details, amount, cost, notes)
     VALUES (?,?,?,?,?,?)`,
    [
      "product_sale",
      "CR", // Credit for sale
      JSON.stringify({
        product_id,
        name: product.name,
        quantity,
        selling_price,
        customer_name,
      }),
      total_amount,
      total_cost,
      customer_name
    ]
  );

  // reduce stock
  await db.execute(
    "UPDATE products SET stock = stock - ? WHERE id = ?",
    [quantity, product_id]
  );

  res.json({ success: true, message: "Sale completed!" });
});

// ---------- SERVICE SERVE ----------
app.post('/api/services/serve', authMiddleware, async (req, res) => {
  try {
    const { service_id, customer_name , selling_price } = req.body;
    const [rows] = await db.execute('SELECT * FROM services WHERE id=?', [service_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Service not found' });
    const service = rows[0];

    // Add transaction
    await db.execute(
      'INSERT INTO transactions (type,t_type, details, amount, cost, notes) VALUES (?,?,?,?,?,?)',
      [
        'service_sale',
        'CR', // Credit for service sale
        JSON.stringify({
          service_id,
          service_name: service.name,
          customer_name,
        }),
        selling_price,
        service.cost,
        `Served service: ${service.name} for ${customer_name || 'Customer'}`,
      ]
    );

    res.json({ success: true, message: 'Service served and transaction recorded.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- TRANSACTION HISTORY ----------
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM transactions ORDER BY date DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ---------- ADD STOCK TO PRODUCT ----------
app.post("/api/products/add-stock", authMiddleware, async (req, res) => {
  const { product_id, quantity, notes } = req.body;

  if (!product_id || !quantity) {
    return res.status(400).json({ error: "Missing product_id or quantity" });
  }

  // 1️⃣ Fetch product
  const [rows] = await db.execute("SELECT * FROM products WHERE id = ?", [product_id]);
  if (rows.length === 0) return res.status(404).json({ error: "Product not found" });

  // 2️⃣ Update stock
  await db.execute(
    "UPDATE products SET stock = stock + ? WHERE id = ?",
    [quantity, product_id]
  );

  // 3️⃣ Record stock addition as a transaction
  const details = {
    product_id,
    quantity_added: quantity,
    product_name: rows[0].name
  };

  await db.execute(
    "INSERT INTO transactions (type,t_type, details, amount, cost, notes) VALUES (?,?,?,?,?,?)",
    [
      "expense",
      "DR", // Debit for adding stock
      JSON.stringify(details),
      0,
      rows[0].cost_price * quantity,
      notes || ""
    ]
  );

  res.json({ success: true, msg: "Stock added successfully" });
});

// Update service (price, name, description)
app.put('/api/services/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, description, price, cost } = req.body;

  try {
    // Check if service exists
    const [existing] = await db.execute('SELECT * FROM services WHERE id=?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Service not found' });

    // Update service
    await db.execute(
      'UPDATE services SET name=?, description=?, price=?, cost=? WHERE id=?',
      [
        name || existing[0].name,
        description || existing[0].description,
        price ?? existing[0].price,
        cost ?? existing[0].cost,
        id
      ]
    );

    res.json({ success: true, message: 'Service updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET transactions by date range
app.get('/api/date/transactions', authMiddleware, async (req, res) => {
  const { from, to } = req.query; // expect YYYY-MM-DD
  const startDate = from || '1970-01-01';
  const endDate = to || '2099-12-31';

  try {
    const [rows] = await db.execute(
      'SELECT * FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date DESC',
      [startDate + ' 00:00:00', endDate + ' 23:59:59']
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// GET /api/reports/balance-sheet

// Get balance sheet (DR/CR)
app.get('/api/reports/balance', authMiddleware, async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2099-12-31';

  // Fetch all transactions in date range
  const [rows] = await db.execute(
    'SELECT * FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date ASC',
    [from, to]
  );

  let totalDr = 0;
  let totalCr = 0;

  // Separate DR and CR totals
  const transactions = rows.map((tx) => {
    let amount = parseFloat(tx.amount || 0);
    let cost = parseFloat(tx.cost || 0);

    if (tx.t_type === 'DR') totalDr += amount;
    if (tx.t_type === 'CR') totalCr += amount;

    return {
      id: tx.id,
      date: tx.date,
      type: tx.t_type,
      details: JSON.parse(tx.details || '{}'),
      amount,
      cost,
      notes: tx.notes
    };
  });

  const netBalance = totalCr - totalDr; // CR > DR = net profit / cash in hand

  res.json({
    totalDr,
    totalCr,
    netBalance,
    transactions
  });
});

// POST /api/transactions expnense/revenue/general transaction
app.post('/api/transactions', authMiddleware, async (req, res) => {
  const { type, details, amount, cost, notes, t_type } = req.body;
  
  // Insert transaction
  const [result] = await db.execute(
    'INSERT INTO transactions (type, details, amount, cost, notes, t_type) VALUES (?,?,?,?,?,?)',
    [type, JSON.stringify(details || {}), amount || 0, cost || 0, notes || '', t_type || 'DR']
  );

  res.json({ id: result.insertId });
});



const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('✅ Backend listening on port', PORT));
