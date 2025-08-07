const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ReportStorage } = require('./reportStorage');

const app = express();
app.use(bodyParser.json());

// Configuration constants
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000,
  TIMEOUTS: {
    NAVIGATION: 300000,    // 5 minutes
    SELECTOR_WAIT: 240000, // 4 minutes
    CHART_WAIT: 90000,     // 1.5 minutes per chart
    PDF_GENERATION: 300000 // 5 minutes
  },
  CHUNK_SIZE: 3 // Process locations in chunks
};

// Setup Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Utility function to chunk arrays
const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

// Enhanced wait function with multiple fallback selectors
async function waitForPageLoad(page, timeout = CONFIG.TIMEOUTS.SELECTOR_WAIT) {
  const selectors = [
    '#report-home-page',
    '.report-container',
    '[data-testid="report"]',
    '.main-content'
  ];
  
  console.log('Waiting for page to load with multiple selectors...');
  
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: timeout / selectors.length });
      console.log(`Found page element: ${selector}`);
      return true;
    } catch (error) {
      console.warn(`Selector ${selector} not found, trying next...`);
    }
  }
  
  throw new Error('Page failed to load - no valid selectors found');
}

// Enhanced chart waiting with better error handling
async function waitForCharts(page, selectors) {
  console.log('Waiting for charts...');
  const loadedCharts = [];
  const failedCharts = [];
  
  // Process charts in chunks to avoid overwhelming the browser
  const chunks = chunkArray(selectors, CONFIG.CHUNK_SIZE);
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (selector) => {
      try {
        await page.waitForSelector(selector, { timeout: CONFIG.TIMEOUTS.CHART_WAIT });
        console.log(`Loaded: ${selector}`);
        loadedCharts.push(selector);
        return { selector, status: 'loaded' };
      } catch (error) {
        console.warn(`Failed to load: ${selector} - ${error.message}`);
        failedCharts.push(selector);
        return { selector, status: 'failed', error: error.message };
      }
    });
    
    await Promise.allSettled(promises);
    
    // Brief pause between chunks to prevent overwhelming
    if (chunks.indexOf(chunk) < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`Charts loaded: ${loadedCharts.length}/${selectors.length}`);
  
  // If less than 70% of charts loaded, consider it a failure
  if (loadedCharts.length < selectors.length * 0.7) {
    throw new Error(`Too many charts failed to load: ${failedCharts.length}/${selectors.length}`);
  }
  
  return { loadedCharts, failedCharts };
}

// Enhanced PDF generation with timeout race
async function generatePDF(page, timeout = CONFIG.TIMEOUTS.PDF_GENERATION) {
  console.log('Generating PDF...');
  
  const pdfPromise = page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
    preferCSSPageSize: true,
    displayHeaderFooter: false
  });
  
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`PDF generation timed out after ${timeout}ms`)), timeout)
  );
  
  try {
    const pdfBuffer = await Promise.race([pdfPromise, timeoutPromise]);
    console.log('PDF generated successfully');
    return pdfBuffer;
  } catch (error) {
    console.error('PDF generation failed:', error.message);
    throw error;
  }
}

// Main report generation function with retry logic
async function generateReportWithRetry(jobData, attempt = 1) {
  const {
    jobId,
    brandId,
    campaignIds,
    fromDate,
    toDate,
    locationIds,
    homePageDetails,
    logo,
    currency,
    timeZone,
    baseURL,
    level
  } = jobData;
  
  let browser;
  
  try {
    console.log(`Report generation attempt ${attempt} for job: ${jobId}`);
    
    // Enhanced browser launch configuration
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
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--max_old_space_size=4096',
        '--memory-pressure-off'
      ],
      executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
      timeout: CONFIG.TIMEOUTS.NAVIGATION
    };
    
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Enhanced page configuration
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );
    
    // Set extra headers
    await page.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    });
    
    // Build URL
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
      level,
      isReport: 'true',
    });
    
    const reportUrl = `${baseURL}/render-chart?${queryParams}`;
    console.log("Opening URL:", reportUrl);
    
    // Update progress
    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 20 });
    
    // Navigate with enhanced waiting
    console.log('Navigating...');
    await page.goto(reportUrl, {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: CONFIG.TIMEOUTS.NAVIGATION,
    });
    
    // Wait for main container
    await waitForPageLoad(page);
    
    // Build chart selectors
    const chartSelectors = [
      'Age & Gender Split Bar Chart',
      'Age & Gender Split Pie Chart',
      'Best Time Chart',
      'Device Split Chart',
    ];
    
    let selectors = [];
    if (level === "Location Level") {
      locationIds?.forEach((location) => {
        chartSelectors?.forEach((select) => {
          selectors?.push(`[id="${select} ${location?.value}"]`)
        })
      })
    } else if (level === "Campaign Level") {
      campaignIds?.forEach((campaign) => {
        chartSelectors?.forEach((select) => {
          selectors?.push(`[id="${select} ${campaign?.value}"]`)
        })
      })
    } else {
      selectors = chartSelectors
    }
    
    console.log(`Processing ${selectors.length} charts`);
    
    // Wait for charts to load
    const chartResults = await waitForCharts(page, selectors);
    
    // Update progress
    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 70 });
    
    // Add a small delay before PDF generation to ensure everything is rendered
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Generate PDF
    const pdfBuffer = await generatePDF(page);
    
    // Clean up browser
    await browser.close();
    browser = null;
    
    // Upload to Supabase
    const filename = `report-${jobId}.pdf`;
    const path = `${brandId}/${filename}`;
    
    console.log('Uploading PDF to storage...');
    const { error: uploadError } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(path, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    
    if (uploadError) {
      console.log({ uploadError });
      throw uploadError;
    }
    
    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(path);
    
    // Update job status
    await ReportStorage.updateJob(jobId, {
      status: 'Download',
      progress: 100,
      downloadUrl: publicUrl.publicUrl,
    });
    
    console.log(`Report generation completed successfully for job: ${jobId}`);
    return { success: true, url: publicUrl.publicUrl, chartResults };
    
  } catch (error) {
    console.error(`Attempt ${attempt} failed:`, error.message);
    
    // Clean up browser if it exists
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError.message);
      }
    }
    
    // Retry logic
    if (attempt < CONFIG.MAX_RETRIES) {
      console.log(`Retrying in ${CONFIG.RETRY_DELAY}ms... (attempt ${attempt + 1}/${CONFIG.MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return generateReportWithRetry(jobData, attempt + 1);
    }
    
    // Final failure
    await ReportStorage.updateJob(jobId, {
      status: 'Failed',
      progress: 0,
      error: error.message,
    });
    
    throw error;
  }
}

// Main endpoint
app.post('/generate-report', async (req, res) => {
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
      baseURL,
      level
    } = req.body;
    
    console.log('Payload received:', {
      requestJobId,
      brandId,
      campaignIds: campaignIds?.length || 0,
      fromDate,
      toDate,
      locationIds: locationIds?.length || 0,
      level,
      baseURL
    });
    
    const jobId = requestJobId;
    console.log("Processing job:", jobId);
    
    // Initial job update
    await ReportStorage.updateJob(jobId, {
      status: 'Processing',
      progress: 10,
    });
    
    // Generate report with retry logic
    const result = await generateReportWithRetry({
      jobId,
      brandId,
      campaignIds,
      fromDate,
      toDate,
      locationIds,
      homePageDetails,
      logo,
      currency,
      timeZone,
      baseURL,
      level
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('Report generation failed:', error.message);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    config: {
      maxRetries: CONFIG.MAX_RETRIES,
      timeouts: CONFIG.TIMEOUTS
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Configuration:', CONFIG);
});