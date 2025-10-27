import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import pg from "pg";
import PDFDocument from "pdfkit";

const db = new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "iDoc",
  password: "250689",
  port: 5432,
});
db.connect();

const app = express();
const port = 3000;

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", async(req, res) => {
  try {
    const result = await axios.get("https://stoic-quotes.com/api/quote");
    const quote = result.data.text;
    const author = result.data.author;
    res.render("index.ejs", { content: quote, author: author });
  } catch (error) {
    res.status(404).send(error.message);
  }
}); 

app.get("/patients", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM patients ORDER BY surname, name"
    );
    res.render("patients.ejs", { patients: result.rows });
  } catch (err) {
    console.error("Error fetching patients:", err);
    res.status(500).send("Error loading patients");
  }
});

// API endpoint to search Italian cities
app.get("/api/cities/search", async (req, res) => {
  try {
    const searchTerm = req.query.q || '';
    if (searchTerm.length < 2) {
      return res.json([]);
    }

    const result = await db.query(
      `SELECT city, province 
       FROM italian_cities 
       WHERE city ILIKE $1 
       ORDER BY city ASC 
       LIMIT 10`,
      [`${searchTerm}%`]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error searching cities:", err);
    res.status(500).json({ error: "Error searching cities" });
  }
});

// API Routes for Patients CRUD operations
app.post("/api/patients", async (req, res) => {
  try {
    const { name, middlename, surname, gender, birthday, birthplace, province, address, fiscalcode, business } = req.body;
    
    const result = await db.query(
      `INSERT INTO patients (name, middlename, surname, gender, birthday, birthplace, province, address, fiscalcode, business) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
       RETURNING *`,
      [
        name, 
        middlename || null, 
        surname,
        gender || null,
        birthday || null,
        birthplace || null,
        province || null,
        address || null, 
        fiscalcode, 
        business || false
      ]
    );
    
    res.status(201).json({
      success: true,
      message: "Patient created successfully",
      patient: result.rows[0]
    });
  } catch (err) {
    console.error("Error creating patient:", err);
    res.status(500).json({ 
      error: "Error creating patient", 
      details: err.message 
    });
  }
});

app.patch("/api/patients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Build the query dynamically based on the fields to update
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    values.push(id);
    
    const query = `UPDATE patients SET ${setClause} WHERE id = $${values.length} RETURNING *`;
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    
    res.json({
      success: true,
      message: "Patient updated successfully",
      patient: result.rows[0]
    });
  } catch (err) {
    console.error("Error updating patient:", err);
    res.status(500).json({ 
      error: "Error updating patient", 
      details: err.message 
    });
  }
});

app.delete("/api/patients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM patients WHERE id = $1 RETURNING *",
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    
    res.json({
      success: true,
      message: "Patient deleted successfully",
      patient: result.rows[0]
    });
  } catch (err) {
    console.error("Error deleting patient:", err);
    res.status(500).json({ 
      error: "Error deleting patient", 
      details: err.message 
    });
  }
});

app.get("/invoices", async (req, res) => {
  try {
    // Join invoices with patients table to get patient names
    const invoicesResult = await db.query(`
      SELECT 
        i.*,
        CONCAT_WS(' ', p.name, p.middlename, p.surname) as patient_name
      FROM invoices i
      LEFT JOIN patients p ON i.fiscalcode = p.fiscalcode
      ORDER BY i.id
    `);
    
    // Helper function to parse currency
    const parseCurrency = (str) => {
      if (!str) return 0;
      const clean = str.replace(/[€$]/g, '').replace(',', '.').trim();
      const num = parseFloat(clean);
      return isNaN(num) ? 0 : num;
    };
    
    // Calculate totals for each invoice
    const invoicesWithTotals = invoicesResult.rows.map(invoice => {
      const dueAmount = parseCurrency(invoice.dueamount);
      const withholding = parseCurrency(invoice.withholding);
      const ritenuta = parseCurrency(invoice.ritenuta);
      
      // Calculate ritenuta (20% of due amount if enabled)
      const ritenutaDeduction = ritenuta > 0 ? dueAmount * 0.20 : 0;
      
      // Subtract ritenuta from due amount, then add withholding
      const total = (dueAmount - ritenutaDeduction) + withholding;
      
      return {
        ...invoice,
        total: '€' + total.toFixed(2).replace('.', ','),
        patient_name: invoice.patient_name || 'Unknown Patient'
      };
    });
    
    // Get unique fiscal codes from patients table for the dropdown
    let fiscalCodes = [];
    try {
      const fiscalCodesResult = await db.query(
        "SELECT fiscalcode, CONCAT_WS(' ', name, middlename, surname) as full_name FROM patients ORDER BY surname, name"
      );
      fiscalCodes = fiscalCodesResult.rows;
    } catch (err) {
      console.log("Could not fetch fiscal codes from patients table:", err.message);
      // Fallback to invoices table
      const fiscalCodesResult = await db.query(
        "SELECT DISTINCT fiscalcode FROM invoices WHERE fiscalcode IS NOT NULL ORDER BY fiscalcode"
      );
      fiscalCodes = fiscalCodesResult.rows.map(row => ({ fiscalcode: row.fiscalcode, full_name: row.fiscalcode }));
    }
    
    res.render("invoices.ejs", { 
      invoices: invoicesWithTotals,
      fiscalCodes: fiscalCodes
    });
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching invoices");
  }
});

// API Routes for CRUD operations

// UPDATE invoice (PATCH)
app.patch("/api/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let updates = { ...req.body };
    
    console.log("Received PATCH request:", { id, updates });
    
    // Helper function to clean currency values
    const cleanCurrency = (value) => {
      if (!value) return value;
      if (typeof value === 'number') return value;
      return value.replace(/[€$]/g, '').replace(',', '.').trim();
    };
    
    // Clean currency fields if they're being updated
    if (updates.dueamount) {
      updates.dueamount = cleanCurrency(updates.dueamount);
      const dueAmountNum = parseFloat(updates.dueamount);
      
      // Automatically recalculate withholding when due amount is updated
      updates.withholding = dueAmountNum > 77.47 ? '2.00' : '0.00';
      
      console.log('Auto-calculated withholding:', updates.withholding);
    }
    
    // If someone tries to manually update withholding, ignore it (security)
    if (updates.withholding && !updates.dueamount) {
      console.log('Ignoring manual withholding update');
      delete updates.withholding;
    }
    
    // Handle boolean values for traced field
    if (updates.traced !== undefined) {
      updates.traced = updates.traced === true || updates.traced === 'true';
    }

    // Handle boolean values for TS field
    if (updates.ts !== undefined) {
      updates.ts = updates.ts === true || updates.ts === 'true';
    }

    // Handle ritenuta calculation
    if (updates.ritenuta !== undefined) {
      updates.ritenuta = updates.ritenuta === true || updates.ritenuta === 'true' ? 20 : 0;
    }
    
    // Handle date fields
    if (updates.invoicedate) {
      updates.invoicedate = updates.invoicedate;
    }
    if (updates.collecteddate) {
      updates.collecteddate = updates.collecteddate || null;
    }
    
    console.log("Cleaned updates:", updates);
    
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No update data provided" });
    }
    
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    values.push(id);
    
    const query = `UPDATE invoices SET ${setClause} WHERE id = $${values.length} RETURNING *`;
    
    console.log("Executing query:", query, values);
    
    const result = await db.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    
    res.json({ 
      success: true, 
      message: "Invoice updated successfully", 
      invoice: result.rows[0] 
    });
  } catch (err) {
    console.log("PATCH error:", err);
    res.status(500).json({ error: "Error updating invoice", details: err.message });
  }
});

// DELETE invoice
app.delete("/api/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log("Received DELETE request for id:", id); // Debug log
    
    const result = await db.query(
      "DELETE FROM invoices WHERE id = $1 RETURNING *",
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    
    res.json({ 
      success: true, 
      message: "Invoice deleted successfully", 
      invoice: result.rows[0] 
    });
  } catch (err) {
    console.log("DELETE error:", err);
    res.status(500).json({ error: "Error deleting invoice", details: err.message });
  }
});

// CREATE invoice (POST)
app.post("/api/invoices", async (req, res) => {
  try {
    console.log("Received POST request:", req.body);
    
    let { dueamount, system, invoicedate, traced, collecteddate, fiscalcode, ts, ritenuta } = req.body;
    
    // Helper function to clean currency values
    const cleanCurrency = (value) => {
      if (!value) return '0';
      return value.replace(/[€$]/g, '').replace(',', '.').trim();
    };
    
    // Clean the currency field
    dueamount = cleanCurrency(dueamount);
    const dueAmountNum = parseFloat(dueamount);
    
    // Calculate withholding automatically based on due amount
    const withholding = dueAmountNum > 77.47 ? '2.00' : '0.00';
    
    console.log("Cleaned values:", { dueamount, withholding, calculated: true });
    
    let query, values;
    
    if (fiscalcode && fiscalcode.trim() !== '') {
      query = `INSERT INTO invoices (dueamount, withholding, system, invoicedate, traced, collecteddate, fiscalcode, ts, ritenuta) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
               RETURNING *`;
      values = [dueamount, withholding, system, invoicedate, traced || false, collecteddate, fiscalcode, ts || false, ritenuta ? 20 : 0];
    } else {
      query = `INSERT INTO invoices (dueamount, withholding, system, invoicedate, traced, collecteddate, ts, ritenuta) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
               RETURNING *`;
      values = [dueamount, withholding, system, invoicedate, traced || false, collecteddate, ts || false, ritenuta ? 20 : 0];
    }
    
    const result = await db.query(query, values);
    
    res.status(201).json({ 
      success: true, 
      message: "Invoice created successfully", 
      invoice: result.rows[0] 
    });
  } catch (err) {
    console.log("POST error details:", {
      error: err,
      message: err.message,
      stack: err.stack,
      requestBody: req.body
    });
    res.status(500).json({ error: "Error creating invoice", details: err.message });
  }
});

// Generate PDF for invoice
app.get("/api/invoices/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT 
        i.*,
        CONCAT_WS(' ', p.name, p.middlename, p.surname) as patient_name,
        p.name as patient_first_name,
        p.middlename as patient_middle_name,
        p.surname as patient_surname,
        p.address as patient_address
      FROM invoices i
      LEFT JOIN patients p ON i.fiscalcode = p.fiscalcode
      WHERE i.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    
    const invoice = result.rows[0];
    
    // Helper function to parse currency
    const parseCurrency = (str) => {
      if (!str) return 0;
      const clean = str.toString().replace(/[€$]/g, '').replace(',', '.').trim();
      const num = parseFloat(clean);
      return isNaN(num) ? 0 : num;
    };
    
    // Helper function to format currency
    const formatCurrency = (num) => {
      return '€' + num.toFixed(2).replace('.', ',');
    };
    
    // Helper function to format date
    const formatDate = (dateStr) => {
      if (!dateStr) return 'N/A';
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric' 
      });
    };
    
    // Calculate amounts
    const dueAmount = parseCurrency(invoice.dueamount);
    const withholding = parseCurrency(invoice.withholding);
    const ritenuta = parseCurrency(invoice.ritenuta) || 0;
    
    // Calculate ritenuta deduction (20% of due amount if ritenuta > 0)
    const ritenutaDeduction = ritenuta > 0 ? dueAmount * 0.20 : 0;
    
    // Calculate total: (dueAmount - ritenuta) + withholding
    const total = (dueAmount - ritenutaDeduction) + withholding;
    
    // Check if stamp is required (due amount > €77.47)
    const requiresStamp = dueAmount > 77.47;
    
    // Create PDF document
    const doc = new PDFDocument({ 
      margin: 50,
      size: 'A4'
    });
    
    // Set response headers for PDF download/display
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${id}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);
    
    // STAMP PLACEHOLDER (if required) - Top Left Corner
    const stampSize = 85.04; // 3cm in points
    if (requiresStamp) {
      const stampX = 50;
      const stampY = 50;
      
      doc.rect(stampX, stampY, stampSize, stampSize)
         .strokeColor('#dc3545')
         .lineWidth(2)
         .dash(5, { space: 3 })
         .stroke();
      
      doc.undash();
      
      doc.fontSize(10)
         .fillColor('#dc3545')
         .font('Helvetica-Bold')
         .text('INSERIRE', stampX, stampY + 25, {
           width: stampSize,
           align: 'center'
         })
         .text('BOLLO', stampX, stampY + 40, {
           width: stampSize,
           align: 'center'
         });
      
      doc.fontSize(7)
         .fillColor('#666666')
         .font('Helvetica')
         .text('€ 2,00', stampX, stampY + 60, {
           width: stampSize,
           align: 'center'
         });
    }
    
    // HEADER SECTION
    doc.fontSize(28)
       .fillColor('#0d6efd')
       .text('INVOICE', { align: 'center' });
    
    doc.fontSize(12)
       .fillColor('#666666')
       .text(`Invoice Number: #${invoice.id}`, { align: 'center' });
    
    doc.moveDown(0.5);
    
    doc.moveTo(50, doc.y)
       .lineTo(545, doc.y)
       .strokeColor('#0d6efd')
       .lineWidth(2)
       .stroke();
    
    doc.moveDown(1.5);
    
    // INVOICE DETAILS SECTION - Two columns
    const leftColumn = 50;
    const rightColumn = 320;
    let currentY = doc.y;
    const startY = currentY;
    
    // Left Column - Patient Information
    doc.fontSize(10)
       .fillColor('#999999')
       .text('BILLED TO:', leftColumn, currentY);
    
    currentY += 20;
    doc.fontSize(14)
       .fillColor('#000000')
       .font('Helvetica-Bold')
       .text(invoice.patient_name || 'Unknown Patient', leftColumn, currentY);
    
    currentY += 20;
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666666')
       .text(`Fiscal Code: ${invoice.fiscalcode || 'N/A'}`, leftColumn, currentY);
    
    if (invoice.patient_address) {
      currentY += 15;
      doc.text(invoice.patient_address, leftColumn, currentY, {
        width: 240,
        align: 'left'
      });
    }
    
    if (invoice.patient_city || invoice.patient_postalcode) {
      currentY += 15;
      const cityLine = [
        invoice.patient_postalcode,
        invoice.patient_city,
        invoice.patient_province ? `(${invoice.patient_province})` : null
      ].filter(Boolean).join(' ');
      
      if (cityLine) {
        doc.text(cityLine, leftColumn, currentY);
      }
    }
    
    if (invoice.patient_country && invoice.patient_country.toUpperCase() !== 'ITALY' && invoice.patient_country.toUpperCase() !== 'ITALIA') {
      currentY += 15;
      doc.font('Helvetica-Bold')
         .text(invoice.patient_country.toUpperCase(), leftColumn, currentY);
      doc.font('Helvetica');
    }
    
    // Right Column - Invoice Information
    currentY = startY;
    
    doc.fontSize(10)
       .fillColor('#999999')
       .text('INVOICE DETAILS:', rightColumn, currentY);
    
    currentY += 20;
    doc.fontSize(10)
       .fillColor('#000000')
       .text('Invoice Date:', rightColumn, currentY);
    doc.text(formatDate(invoice.invoicedate), rightColumn + 100, currentY);
    
    currentY += 18;
    doc.text('Payment System:', rightColumn, currentY);
    doc.text(invoice.system || 'Not specified', rightColumn + 100, currentY);
    
    currentY += 18;
    doc.text('Status:', rightColumn, currentY);
    doc.fillColor(invoice.traced ? '#28a745' : '#dc3545')
       .text(invoice.traced ? 'Traced' : 'Not Traced', rightColumn + 100, currentY);
    
    if (invoice.collecteddate) {
      currentY += 18;
      doc.fillColor('#000000')
         .text('Collected Date:', rightColumn, currentY);
      doc.text(formatDate(invoice.collecteddate), rightColumn + 100, currentY);
    }
    
    doc.y = Math.max(doc.y, currentY + 30);
    doc.moveDown(1);
    
    // TABLE SECTION
    const tableTop = doc.y + 20;
    const descriptionX = 50;
    const amountX = 450;
    
    // Table header
    doc.rect(50, tableTop, 495, 30)
       .fillColor('#f8f9fa')
       .fill();
    
    doc.fontSize(11)
       .fillColor('#000000')
       .font('Helvetica-Bold')
       .text('DESCRIPTION', descriptionX + 10, tableTop + 10)
       .text('AMOUNT', amountX, tableTop + 10, { width: 85, align: 'right' });
    
    // Table rows
    let rowY = tableTop + 40;
    
    doc.font('Helvetica')
       .fontSize(10);
    
    // Due Amount row
    doc.fillColor('#000000')
       .text('Totale (Esente art.10 - N.4)', descriptionX + 10, rowY)
       .text(formatCurrency(dueAmount), amountX, rowY, { width: 85, align: 'right' });
    
    rowY += 25;
    doc.moveTo(50, rowY)
       .lineTo(545, rowY)
       .strokeColor('#dddddd')
       .lineWidth(1)
       .stroke();
    
    rowY += 15;
    
    // Ritenuta row (if applicable) - SHOW AS DEDUCTION
    if (ritenuta > 0) {
      doc.fillColor('#000000')
         .fontSize(10)
         .text('Ritenuta d\'acconto (20%)', descriptionX + 10, rowY)
         .text('-' + formatCurrency(ritenutaDeduction), amountX, rowY, { width: 85, align: 'right' });
      
      rowY += 25;
      doc.moveTo(50, rowY)
         .lineTo(545, rowY)
         .strokeColor('#dddddd')
         .lineWidth(1)
         .stroke();
      
      rowY += 15;
    }
    
    // Withholding row
    doc.fillColor('#000000')
       .fontSize(10)
       .text('Bollo', descriptionX + 10, rowY)
       .text(formatCurrency(withholding), amountX, rowY, { width: 85, align: 'right' });
    
    rowY += 25;
    doc.moveTo(50, rowY)
       .lineTo(545, rowY)
       .strokeColor('#dddddd')
       .lineWidth(1)
       .stroke();
    
    rowY += 15;
    
    // TOTAL SECTION
    doc.rect(350, rowY, 195, 40)
       .fillColor('#e7f5ff')
       .fill();
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#0d6efd')
       .text('TOTAL AMOUNT:', 360, rowY + 12)
       .text(formatCurrency(total), amountX, rowY + 12, { width: 85, align: 'right' });
    
    // SIGNATURE SECTION
    const signatureY = rowY + 80;
    
    try {
      doc.image('public/images/signature.png', 350, signatureY, { 
        width: 150,
        align: 'right'
      });
      
      doc.moveTo(350, signatureY + 60)
         .lineTo(500, signatureY + 60)
         .strokeColor('#000000')
         .lineWidth(1)
         .stroke();
      
      doc.fontSize(10)
         .fillColor('#000000')
         .font('Helvetica')
         .text('Authorized Signature', 350, signatureY + 65, { 
           width: 150, 
           align: 'center' 
         });
         
      doc.fontSize(8)
         .fillColor('#666666')
         .text(`Date: ${formatDate(new Date())}`, 350, signatureY + 80, { 
           width: 150, 
           align: 'center' 
         });
         
    } catch (err) {
      console.log('Signature image not found:', err.message);
      doc.fontSize(10)
         .fillColor('#000000')
         .font('Helvetica-Bold')
         .text('Authorized by:', 350, signatureY)
         .fontSize(8)
         .fillColor('#666666')
         .text('[Signature image not available]', 350, signatureY + 20);
    }
    
    // FOOTER SECTION
    const footerY = 700;
    
    doc.moveTo(50, footerY)
       .lineTo(545, footerY)
       .strokeColor('#dddddd')
       .lineWidth(1)
       .stroke();
    
    doc.fontSize(8)
       .text('This is a computer-generated invoice with digital signature.', 
             50, footerY + 35, { align: 'center' });
    
    doc.text(`Generated on: ${new Date().toLocaleString('en-GB')}`, 
             50, footerY + 50, { align: 'center' });
    
    // Finalize PDF
    doc.end();
    
  } catch (err) {
    console.log("PDF generation error:", err);
    res.status(500).json({ error: "Error generating PDF", details: err.message });
  }
});


app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

