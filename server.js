const express = require('express');
const puppeteer = require('puppeteer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ReportStorage } = require('./reportStorage');

const app = express();
app.use(express.json({ limit: '10mb' })); // Reduced limit

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Prevent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  setTimeout(() => process.exit(1), 3000);
});

async function safeUpdateJob(jobId, updates) {
  try {
    await ReportStorage.updateJob(jobId, updates);
  } catch (error) {
    console.error(`Job update failed: ${error.message}`);
  }
}

app.post('/generate-report', async (req, res) => {
  let browser;
  const { jobId, baseURL, brandId, selectors } = req.body;
  
  if (!jobId || !baseURL || !brandId || !selectors) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    console.log(`Starting job: ${jobId}`);
    await safeUpdateJob(jobId, { status: 'Processing', progress: 10 });

    // Minimal browser launch
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      timeout: 30000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    
    // Block images to save memory
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.resourceType() === 'image') {
        req.abort();
      } else {
        req.continue();
      }
    });

    const url = `${baseURL}/render-chart?jobId=${jobId}&isReport=true`;
    console.log(`Navigating to: ${url}`);
    
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });

    await safeUpdateJob(jobId, { status: 'Processing', progress: 50 });

    // Wait for main container
    await page.waitForSelector('#report-home-page', { timeout: 30000 });

    // Simple selector loading
    for (const selector of selectors.slice(0, 10)) { // Limit to 10
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
      } catch (e) {
        console.warn(`Selector failed: ${selector}`);
      }
    }

    await safeUpdateJob(jobId, { status: 'Processing', progress: 80 });

    // Generate PDF with minimal options
    console.log('Generating PDF...');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: false,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      timeout: 30000 // 30 seconds max
    });

    await browser.close();
    console.log(`PDF generated: ${pdf.length} bytes`);

    // Upload
    const path = `${brandId}/report-${jobId}.pdf`;
    const { error } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: true });

    if (error) throw error;

    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(path);

    await safeUpdateJob(jobId, {
      status: 'Download',
      progress: 100,
      download_url: publicUrl.publicUrl
    });

    res.json({ success: true, url: publicUrl.publicUrl });

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error.message);
    
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    
    await safeUpdateJob(jobId, {
      status: 'Failed',
      progress: 0,
      error: error.message
    });

    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', memory: process.memoryUsage() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Minimal PDF server running on port ${PORT}`);
});