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
  MAX_RETRIES: 2, // Reduced retries since the issue seems consistent
  RETRY_DELAY: 10000,
  TIMEOUTS: {
    NAVIGATION: 120000,    // 2 minutes - more realistic
    SELECTOR_WAIT: 120000, // 2 minutes
    CHART_WAIT: 60000,     // 1 minute per chart
    PDF_GENERATION: 180000 // 3 minutes
  },
  CHUNK_SIZE: 3
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

// URL validation and network diagnostics
async function validateURL(url, page) {
  console.log('Validating URL accessibility...');
  
  try {
    // Try a simple HEAD request first using page.evaluate
    const response = await page.evaluate(async (testUrl) => {
      try {
        const response = await fetch(testUrl, { method: 'HEAD' });
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message
        };
      }
    }, url);
    
    if (!response.ok) {
      console.warn(`URL validation failed: ${response.status} - ${response.statusText || response.error}`);
      return false;
    }
    
    console.log('URL is accessible');
    return true;
  } catch (error) {
    console.warn('URL validation error:', error.message);
    return false;
  }
}

// Enhanced wait function with multiple fallback selectors
async function waitForPageLoad(page, timeout = 60000) {
  const selectors = [
    '#report-home-page',
    '.report-container',
    '[data-testid="report"]',
    '.main-content',
    'body' // Ultimate fallback
  ];
  
  console.log('Waiting for page to load...');
  
  // First, just wait a bit for initial rendering
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: timeout / selectors.length });
      console.log(`Found page element: ${selector}`);
      
      // Additional wait to ensure content is actually rendered
      await new Promise(resolve => setTimeout(resolve, 1000));
      return true;
    } catch (error) {
      console.warn(`Selector ${selector} not found, trying next...`);
    }
  }
  
  // If no selectors found, check if page has basic HTML content
  try {
    const hasContent = await page.evaluate(() => {
      return document.body && document.body.innerHTML.trim().length > 0;
    });
    
    if (hasContent) {
      console.log('Page has content, proceeding...');
      return true;
    }
  } catch (evalError) {
    console.warn('Could not evaluate page content');
  }
  
  throw new Error('Page failed to load - no valid content found');
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
    baseURL,
    level
  } = jobData;
  
  let browser;
  
  try {
    console.log(`Report generation attempt ${attempt} for job: ${jobId}`);
    
    // Enhanced browser launch configuration for better compatibility
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-field-trial-config',
        '--disable-back-forward-cache',
        '--disable-ipc-flooding-protection',
        '--enable-features=NetworkService,NetworkServiceLogging',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-crash-upload',
        '--disable-breakpad'
      ],
      executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
      timeout: 30000, // Quick browser launch
      ignoreDefaultArgs: ['--disable-extensions'] // Allow some default behavior
    };
    
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Enhanced page configuration
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );
    
    // Don't set overly restrictive timeouts initially
    page.setDefaultTimeout(60000); // 1 minute for selectors
    page.setDefaultNavigationTimeout(120000); // 2 minutes for navigation
    
    // Simpler headers that won't interfere
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    
    // Enable request/response logging for debugging
    page.on('response', response => {
      if (response.url().includes('render-chart')) {
        console.log(`Response: ${response.status()} ${response.url()}`);
      }
    });
    
    page.on('requestfailed', request => {
      console.log(`Request failed: ${request.url()} - ${request.failure().errorText}`);
    });
    
    // Build URL
    const queryParams = new URLSearchParams({
      jobId,
      isReport: 'true',
    });
    
    const reportUrl = `${baseURL}/render-chart?${queryParams}`;
    console.log("Opening URL:", reportUrl);
    console.log("URL length:", reportUrl.length);
    
    // Update progress
    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 20 });
    
    // Navigate with simpler, more reliable approach
    console.log('Navigating...');
    
    try {
      // Start with the most permissive navigation strategy
      console.log('Attempting navigation with domcontentloaded...');
      const response = await page.goto(reportUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000 // 2 minutes should be plenty
      });
      
      console.log(`Navigation response status: ${response.status()}`);
      
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
      }
      
      console.log('Navigation successful, waiting for page to settle...');
      
      // Give the page a moment to start rendering
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (navError) {
      console.error('Primary navigation failed:', navError.message);
      
      // Fallback: try with no wait conditions
      console.log('Attempting fallback navigation...');
      try {
        await page.goto(reportUrl, {
          waitUntil: 'commit',
          timeout: 60000
        });
        console.log('Fallback navigation succeeded');
        
        // Wait longer for content to load
        await new Promise(resolve => setTimeout(resolve, 10000));
        
      } catch (fallbackError) {
        console.error('Fallback navigation also failed:', fallbackError.message);
        throw new Error(`Navigation failed: ${navError.message}. Fallback also failed: ${fallbackError.message}`);
      }
    }
    
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
    
    // Check if it's a navigation timeout - might need different approach
    if (error.message.includes('Navigation timeout') || error.message.includes('Timed out')) {
      console.error('Navigation timeout detected - this might indicate server issues');
      
      // For navigation timeouts, wait longer before retry
      if (attempt < CONFIG.MAX_RETRIES) {
        const extendedDelay = CONFIG.RETRY_DELAY * (attempt + 1); // Progressive delay
        console.log(`Navigation timeout - waiting ${extendedDelay}ms before retry... (attempt ${attempt + 1}/${CONFIG.MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, extendedDelay));
        return generateReportWithRetry(jobData, attempt + 1);
      }
    }
    
    // Retry logic for other errors
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

// URL diagnostic endpoint
app.post('/diagnose-url', async (req, res) => {
  let browser;
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    console.log('Diagnosing URL:', url);
    
    // Launch minimal browser for diagnosis
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    const startTime = Date.now();
    
    try {
      // Try simple navigation
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const loadTime = Date.now() - startTime;
      
      // Get page title and basic info
      const title = await page.title();
      const pageUrl = page.url();
      
      await browser.close();
      
      res.json({
        success: true,
        loadTime,
        title,
        finalUrl: pageUrl,
        timestamp: new Date().toISOString()
      });
      
    } catch (navError) {
      await browser.close();
      res.json({
        success: false,
        error: navError.message,
        loadTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Configuration:', CONFIG);
});