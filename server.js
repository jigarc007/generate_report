const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ReportStorage } = require('./reportStorage');

const app = express();
app.use(bodyParser.json({ limit: '50mb' })); // Increase payload limit for large requests

// Setup Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Global browser instance for reuse (optional optimization)
let globalBrowser = null;

// Utility function for safe job updates
async function safeUpdateJob(jobId, updates) {
  try {
    await ReportStorage.updateJob(jobId, updates);
  } catch (error) {
    console.error(`Failed to update job ${jobId}:`, error);
  }
}

// Enhanced browser launch for large PDF generation
async function launchOptimizedBrowser() {
  const executablePath = process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome';
  
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-webgl',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      // Memory optimizations for large PDFs
      '--memory-pressure-off',
      '--max_old_space_size=8192', // Increase Node.js memory limit
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      // Resource limits
      '--max-memory-usage=4096',
      '--aggressive-cache-discard',
      '--disable-blink-features=AutomationControlled'
    ],
    executablePath: executablePath,
    timeout: 120000,
    // Increase default memory limits
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  };
  
  return await puppeteer.launch(launchOptions);
}

// Optimized PDF generation function for large documents
async function generateLargePDF(page, options = {}) {
  const defaultOptions = {
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
    preferCSSPageSize: true,
    timeout: 300000, // 5 minutes - reduced from 10 for better reliability
    omitBackground: false,
    pageRanges: '', // Generate all pages
  };
  
  const pdfOptions = { ...defaultOptions, ...options };
  
  // Multiple attempt strategy with different configurations
  const strategies = [
    // Strategy 1: Optimized quality with reasonable timeout
    { 
      ...pdfOptions,
      timeout: 180000, // 3 minutes
      printBackground: true,
      preferCSSPageSize: true
    },
    
    // Strategy 2: Reduced features for compatibility
    { 
      format: 'A4',
      printBackground: true,
      margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
      timeout: 120000, // 2 minutes
      omitBackground: false
    },
    
    // Strategy 3: Most basic configuration
    { 
      format: 'A4',
      printBackground: false,
      timeout: 60000, // 1 minute
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    }
  ];
  
  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`PDF generation attempt ${i + 1}/${strategies.length} with options:`, {
        format: strategies[i].format,
        timeout: strategies[i].timeout,
        printBackground: strategies[i].printBackground,
        margin: strategies[i].margin
      });
      
      // Pre-generation checks
      const pageContent = await page.content();
      console.log(`Page content length: ${pageContent.length} characters`);
      
      const startTime = Date.now();
      const pdfBuffer = await page.pdf(strategies[i]);
      const endTime = Date.now();
      
      console.log(`PDF generated successfully with strategy ${i + 1}:`, {
        size: `${pdfBuffer.length} bytes (${Math.round(pdfBuffer.length / 1024)} KB)`,
        duration: `${endTime - startTime}ms`,
        estimatedPages: Math.ceil(pdfBuffer.length / (1024 * 50)) // Rough estimate
      });
      
      return pdfBuffer;
      
    } catch (error) {
      console.error(`PDF generation attempt ${i + 1} failed:`, {
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n'), // First 3 lines of stack
        strategy: i + 1
      });
      
      if (i === strategies.length - 1) {
        // Last attempt failed, throw comprehensive error
        throw new Error(`All ${strategies.length} PDF generation attempts failed. Last error: ${error.message}. Suggestions: 1) Check page content size, 2) Verify all elements are loaded, 3) Consider reducing page complexity.`);
      }
      
      // Clean up memory between attempts
      if (global.gc) {
        console.log('Running garbage collection between PDF attempts...');
        global.gc();
      }
      
      // Wait before next attempt
      console.log(`Waiting 3 seconds before attempt ${i + 2}...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// Memory cleanup utility
function forceMemoryCleanup() {
  if (global.gc) {
    console.log('Forcing garbage collection...');
    global.gc();
  }
}

app.post('/generate-report', async (req, res) => {
  let browser, reportJobId, page;
  
  try {
    const { jobId, baseURL, brandId, selectors } = req.body;
    
    // Validate required fields
    if (!jobId || !baseURL || !brandId || !selectors) {
      return res.status(400).json({ 
        error: 'Missing required fields: jobId, baseURL, brandId, or selectors' 
      });
    }
    
    console.log('Processing large PDF job:', jobId, {
      brandId,
      baseURL,
      selectorCount: selectors.length,
      estimatedPages: Math.ceil(selectors.length / 5) // Rough estimate
    });
    
    reportJobId = jobId;
    
    await safeUpdateJob(jobId, {
      status: 'Processing',
      progress: 5,
    });

    // Launch optimized browser
    console.log('Launching optimized browser for large PDF...');
    browser = await launchOptimizedBrowser();
    page = await browser.newPage();
    
    // Optimize page for large content
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );

    // Set page timeouts for large content (reduced for better reliability)
    await page.setDefaultNavigationTimeout(180000); // 3 minutes
    await page.setDefaultTimeout(120000); // 2 minutes

    // Intercept requests to optimize loading
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      // Block unnecessary resources for PDF generation
      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        // Allow but with lower priority
        request.continue();
      } else if (['media', 'websocket', 'other'].includes(resourceType)) {
        // Block non-essential resources
        request.abort();
      } else {
        request.continue();
      }
    });

    // Error handling
    page.on('error', (error) => {
      console.error('Page error:', error);
    });

    page.on('pageerror', (error) => {
      console.error('Page script error:', error);
    });

    // Build report URL
    const queryParams = new URLSearchParams({
      jobId,
      isReport: 'true',
      largePdf: 'true', // Signal to the frontend
    });
    const reportUrl = `${baseURL}/render-chart?${queryParams}`;
    
    console.log('Navigating to large content:', reportUrl);
    await safeUpdateJob(jobId, { status: 'Processing', progress: 10 });

    // Navigate with extended timeout
    await page.goto(reportUrl, {
      waitUntil: 'domcontentloaded', // Less strict than networkidle2 for large content
      timeout: 300000, // 5 minutes
    });

    console.log('Waiting for main container...');
    await page.waitForSelector('#report-home-page', { 
      visible: true, 
      timeout: 300000 // 5 minutes for large content
    });

    await safeUpdateJob(jobId, { status: 'Processing', progress: 20 });

    // Load selectors with patience for large content
    console.log('Loading large number of chart selectors...');
    const loadedSelectors = [];
    const failedSelectors = [];
    const batchSize = 10; // Process selectors in batches
    
    for (let i = 0; i < selectors.length; i += batchSize) {
      const batch = selectors.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(selectors.length/batchSize)}`);
      
      await Promise.allSettled(
        batch.map(async (selector) => {
          try {
            await page.waitForSelector(selector, { timeout: 60000 });
            loadedSelectors.push(selector);
            console.log(`✓ Loaded: ${selector}`);
          } catch (error) {
            failedSelectors.push(selector);
            console.warn(`✗ Failed to load: ${selector}`);
          }
        })
      );
      
      // Update progress during batch processing
      const progress = 20 + Math.floor((i / selectors.length) * 50);
      await safeUpdateJob(jobId, { status: 'Processing', progress });
      
      // Memory cleanup between batches
      if (i > 0 && i % (batchSize * 3) === 0) {
        forceMemoryCleanup();
      }
    }

    console.log(`Selector loading summary: ${loadedSelectors.length}/${selectors.length} loaded`);
    await safeUpdateJob(jobId, { status: 'Processing', progress: 75 });

    // Optimize page for PDF generation
    console.log('Optimizing page for large PDF generation...');
    
    // Disable all animations and transitions more aggressively
    await page.evaluate(() => {
      // Create comprehensive CSS to disable animations
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          animation-fill-mode: none !important;
          transition-timing-function: linear !important;
        }
        
        /* Optimize for PDF printing */
        @media print {
          * {
            -webkit-print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
        }
        
        /* Reduce memory usage */
        img {
          image-rendering: optimizeSpeed !important;
        }
      `;
      document.head.appendChild(style);
      
      // Force layout recalculation
      document.body.offsetHeight;
    });

    // Wait for final rendering with extended time for large content
    console.log('Waiting for final rendering of large content...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    await safeUpdateJob(jobId, { status: 'Processing', progress: 85 });

    // Force memory cleanup before PDF generation
    forceMemoryCleanup();

    console.log('Generating large PDF...');
    
    // Use optimized PDF generation with better error handling
    let pdfBuffer;
    try {
      // Check page state before PDF generation
      const pageTitle = await page.title();
      const url = page.url();
      console.log('Page state before PDF generation:', { title: pageTitle, url });
      
      // Verify content is still loaded
      const mainContainer = await page.$('#report-home-page');
      if (!mainContainer) {
        throw new Error('Main container no longer found on page');
      }
      
      pdfBuffer = await generateLargePDF(page, {
        format: 'A4',
        printBackground: true,
        margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
        preferCSSPageSize: true,
        timeout: 180000, // 3 minutes - more realistic timeout
      });
      
    } catch (pdfError) {
      console.error('PDF generation error details:', {
        message: pdfError.message,
        jobId,
        selectors: selectors.length,
        loadedSelectors: loadedSelectors.length
      });
      throw pdfError;
    }

    console.log(`Large PDF generated successfully (${pdfBuffer.length} bytes, ~${Math.ceil(pdfBuffer.length / (1024 * 200))} estimated pages)`);
    
    // Close browser immediately after PDF generation
    await browser.close();
    browser = null;
    page = null;

    // Force cleanup after PDF generation
    forceMemoryCleanup();

    await safeUpdateJob(jobId, { status: 'Processing', progress: 95 });

    // Upload to Supabase with retry for large files
    const filename = `large-report-${jobId}.pdf`;
    const path = `${brandId}/${filename}`;
    
    console.log('Uploading large PDF:', { filename, path, size: pdfBuffer.length });

    let uploadAttempts = 0;
    const maxUploadAttempts = 3;
    let uploadSuccess = false;

    while (uploadAttempts < maxUploadAttempts && !uploadSuccess) {
      try {
        uploadAttempts++;
        console.log(`Upload attempt ${uploadAttempts}/${maxUploadAttempts}`);
        
        const { error: uploadError, data } = await supabase
          .storage
          .from('Creatives/brand-uploaded')
          .upload(path, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (uploadError) {
          throw uploadError;
        }

        console.log('Large PDF upload successful:', data);
        uploadSuccess = true;
        
      } catch (uploadError) {
        console.warn(`Upload attempt ${uploadAttempts} failed:`, uploadError.message);
        
        if (uploadAttempts === maxUploadAttempts) {
          throw new Error(`Upload failed after ${maxUploadAttempts} attempts: ${uploadError.message}`);
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Get public URL
    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(path);

    // Final job update
    await safeUpdateJob(jobId, {
      status: 'Download',
      progress: 100,
      download_url: publicUrl.publicUrl,
     });

    console.log(`Large PDF job ${jobId} completed successfully`);
    res.json({ 
      success: true, 
      url: publicUrl.publicUrl,
      summary: {
        totalSelectors: selectors.length,
        loadedSelectors: loadedSelectors.length,
        failedSelectors: failedSelectors.length,
        pdfSize: pdfBuffer.length,
        estimatedPages: Math.ceil(pdfBuffer.length / (1024 * 200))
      }
    });

  } catch (error) {
    console.error('Large PDF job failed:', error);
    
    // Cleanup
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    
    // Force memory cleanup on error
    forceMemoryCleanup();
    
    // Update job status
    if (reportJobId) {
      await safeUpdateJob(reportJobId, {
        status: 'Failed',
        progress: 0,
        error: error.message,
      });
    }
    
    // Send error response
    const statusCode = error.message.includes('Missing required fields') ? 400 : 500;
    res.status(statusCode).json({ 
      error: error.message,
      jobId: reportJobId,
      suggestion: 'Consider reducing content size or splitting into smaller PDFs'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Graceful shutdown handling with cleanup
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (globalBrowser) {
    await globalBrowser.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (globalBrowser) {
    await globalBrowser.close();
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Large PDF Generator running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('Optimized for large PDF generation (100+ pages)');
});