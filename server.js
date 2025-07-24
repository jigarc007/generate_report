const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ReportStorage } = require('./reportStorage');

const app = express();
app.use(bodyParser.json());

// Setup Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post('/generate-report', async (req, res) => {
  let browser;
  let jobId;

  try {
    const {
      jobId: requestJobId,
      brandId,
      campaignIds,
      fromDate,
      toDate,
      locationIds,
      homePageDetails,
      logo,
      currency,
      timeZone,
      baseURL
    } = req.body;

    jobId = requestJobId;
    console.log("Processing job:", jobId);

    await ReportStorage.updateJob(jobId, {
      status: 'Processing',
      progress: 10,
    });

    // Enhanced browser launch configuration for cloud environments
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
    };

    // Check for Puppeteer's downloaded Chrome first
    const fs = require('fs');
    const path=require('path')
    console.log('Checking Puppeteer cache directory...');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    console.log('Cache directory:', cacheDir);
    
    try {
      if (fs.existsSync(cacheDir)) {
        const chromeDir = path.join(cacheDir, 'chrome');
        if (fs.existsSync(chromeDir)) {
          const versions = fs.readdirSync(chromeDir);
          console.log('Available Chrome versions:', versions);
          
          if (versions.length > 0) {
            // Use the first available version
            const versionDir = path.join(chromeDir, versions[0]);
            const chromePath = path.join(versionDir, 'chrome-linux64', 'chrome');
            
            if (fs.existsSync(chromePath)) {
              console.log('Found Chrome at:', chromePath);
              launchOptions.executablePath = chromePath;
            }
          }
        }
      }
    } catch (error) {
      console.log('Error checking cache directory:', error.message);
    }

    console.log('Launch options:', JSON.stringify(launchOptions, null, 2));
    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );

    const queryParams = new URLSearchParams({
      brandId: brandId?.toString(),
      campaignIds: JSON.stringify(campaignIds || []),
      fromDate,
      toDate,
      currency,
      locationIds: JSON.stringify(locationIds),
      homePageDetails,
      logo: JSON.stringify(logo),
      timeZone,
      isReport: 'true',
    });

    const reportUrl = `${baseURL}/render-chart?${queryParams}`;
    console.log("Opening URL:", reportUrl);

    await page.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    });

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 20 });

    console.log('Navigating...');
    await page.goto(reportUrl, {
      waitUntil: 'networkidle0',
      timeout: 120000,
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 30 });

    console.log('Waiting for main container...');
    await page.waitForSelector('#report-home-page', { visible: true, timeout: 180000 });

    const chartSelectors = [
      '[id="Age & Gender Split Chart 01"]',
      '[id="Age & Gender Split Chart 02"]',
      '[id="Best Time Chart"]',
      '[id="Device Split Chart"]',
    ];

    console.log('Waiting for charts...');
    for (const selector of chartSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 60000 });
        console.log(`Loaded: ${selector}`);
      } catch {
        console.warn(`Failed to load: ${selector}`);
      }
    }

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 70 });

    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });

    await browser.close();
    browser = null;

    const filename = `report-${jobId}.pdf`;
    const pdfPath = `${brandId}/${filename}`;

    const { error: uploadError } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(pdfPath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(pdfPath);

    await ReportStorage.updateJob(jobId, {
      status: 'Download',
      progress: 100,
      downloadUrl: publicUrl.publicUrl,
    });

    res.json({ success: true, url: publicUrl.publicUrl });

  } catch (error) {
    console.error('Failed:', error);
    if (browser) await browser.close();
    if (jobId) {
      await ReportStorage.updateJob(jobId, {
        status: 'Failed',
        progress: 0,
        error: error.message,
      });
    }
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});