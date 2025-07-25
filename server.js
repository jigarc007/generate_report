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
    console.log('payload body:>',{
      requestJobId,
      brandId,
      campaignIds,
      fromDate,
      toDate,
      locationIds,
      homePageDetails,
      logo,
      currency,
      timeZone,
      baseURL});
    jobId = requestJobId;
    console.log("Processing job:", jobId);

    await ReportStorage.updateJob(jobId, {
      status: 'Processing',
      progress: 10,
    });

    // Determine the executable path based on the environment
    // For Render with Docker, Chrome is installed at /usr/bin/google-chrome
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome';

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
        '--disable-gpu'
      ],
      executablePath: executablePath, // Use the dynamically determined path
    };
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
      waitUntil: 'networkidle2',
      timeout: 180000,
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

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
        await page.waitForSelector(selector, { timeout: 120000 });
        console.log(`Loaded: ${selector}`);
      } catch {
        console.warn(`Failed to load: ${selector}`);
      }
    }

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 70 });

    console.log('Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      timeout: 120000,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    await browser.close();
    browser = null;

    const filename = `report-${jobId}.pdf`;
    const path = `${brandId}/${filename}`;

    const { error: uploadError } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(path, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError){
    console.log({uploadError})
      throw uploadError;
    }
    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(path);

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