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

// Utility functions
async function safeUpdateJob(jobId, updates) {
  try {
    await ReportStorage.updateJob(jobId, updates);
    console.log(`Job ${jobId} updated:`, updates);
  } catch (error) {
    console.error(`Failed to update job ${jobId}:`, error);
  }
}

async function safeBrowserCleanup(browser) {
  if (browser) {
    try {
      await browser.close();
      console.log('Browser closed successfully');
    } catch (closeError) {
      console.error('Error closing browser:', closeError);
    }
  }
}

app.post('/generate-report', async (req, res) => {
  let browser, reportJobId;
  const startTime = Date.now();
  
  try {
    const { jobId, baseURL, brandId, selectors } = req.body;
    
    if (!jobId || !baseURL || !brandId || !selectors) {
      return res.status(400).json({ 
        error: 'Missing required fields: jobId, baseURL, brandId, or selectors' 
      });
    }
    
    console.log(`\n=== Starting PDF Generation ===`);
    console.log('Job Details:', {
      jobId,
      brandId,
      baseURL,
      selectorCount: selectors.length,
      timestamp: new Date().toISOString()
    });
    
    reportJobId = jobId;
    await safeUpdateJob(jobId, { status: 'Processing', progress: 10 });

    // Launch browser with optimized but reliable settings
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome';
    
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--single-process', // Helps with memory management
        '--memory-pressure-off',
        '--max_old_space_size=4096' // 4GB limit
      ],
      executablePath: executablePath,
      timeout: 60000,
    });
    
    const page = await browser.newPage();
    
    // Set reasonable viewport and user agent
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );

    // Set up error logging
    page.on('error', (error) => console.error('Page error:', error.message));
    page.on('pageerror', (error) => console.error('Page script error:', error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('Browser console error:', msg.text());
      }
    });

    // Build and navigate to URL
    const queryParams = new URLSearchParams({ jobId, isReport: 'true' });
    const reportUrl = `${baseURL}/render-chart?${queryParams}`;
    
    console.log('Navigating to:', reportUrl);
    await safeUpdateJob(jobId, { status: 'Processing', progress: 20 });

    try {
      await page.goto(reportUrl, {
        waitUntil: 'networkidle2',
        timeout: 120000, // 2 minutes
      });
    } catch (navError) {
      console.error('Navigation failed:', navError.message);
      // Try with less strict wait condition
      await page.goto(reportUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
    }

    console.log('Waiting for main container...');
    await page.waitForSelector('#report-home-page', { 
      visible: true, 
      timeout: 90000 
    });

    await safeUpdateJob(jobId, { status: 'Processing', progress: 40 });

    // Load selectors with detailed logging
    console.log('Loading chart selectors...');
    const loadedSelectors = [];
    const failedSelectors = [];
    
    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      try {
        console.log(`Loading selector ${i + 1}/${selectors.length}: ${selector}`);
        await page.waitForSelector(selector, { timeout: 30000 });
        loadedSelectors.push(selector);
        console.log(`✓ Loaded: ${selector}`);
      } catch (error) {
        failedSelectors.push(selector);
        console.warn(`✗ Failed: ${selector} - ${error.message}`);
      }
      
      // Update progress during loading
      const progress = 40 + Math.floor((i / selectors.length) * 30);
      await safeUpdateJob(jobId, { status: 'Processing', progress });
    }

    console.log(`\nSelector Summary: ${loadedSelectors.length}/${selectors.length} loaded`);
    if (failedSelectors.length > 0) {
      console.warn('Failed selectors:', failedSelectors);
    }

    await safeUpdateJob(jobId, { status: 'Processing', progress: 75 });

    // Optimize page for PDF generation
    console.log('Optimizing page for PDF...');
    await page.evaluate(() => {
      // Disable animations
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `;
      document.head.appendChild(style);
    });

    // Wait for final rendering
    console.log('Waiting for final rendering...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    await safeUpdateJob(jobId, { status: 'Processing', progress: 85 });

    // Generate PDF with multiple fallback strategies
    console.log('Starting PDF generation...');
    let pdfBuffer = null;
    const pdfStrategies = [
      {
        name: "High Quality",
        options: {
          format: 'A4',
          printBackground: true,
          margin: { top: '0', bottom: '0', left: '0', right: '0' },
          preferCSSPageSize: true,
          timeout: 120000 // 2 minutes
        }
      },
      {
        name: "Standard Quality",
        options: {
          format: 'A4',
          printBackground: true,
          margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
          timeout: 90000 // 1.5 minutes
        }
      },
      {
        name: "Basic Quality",
        options: {
          format: 'A4',
          printBackground: false,
          margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
          timeout: 60000 // 1 minute
        }
      }
    ];

    for (let i = 0; i < pdfStrategies.length; i++) {
      try {
        const strategy = pdfStrategies[i];
        console.log(`PDF attempt ${i + 1}/${pdfStrategies.length}: ${strategy.name}`);
        
        // Check page is still responsive
        const title = await page.title();
        console.log('Page title:', title);
        
        const pdfStartTime = Date.now();
        pdfBuffer = await page.pdf(strategy.options);
        const pdfEndTime = Date.now();
        
        console.log(`✓ PDF generated successfully:`, {
          strategy: strategy.name,
          size: `${Math.round(pdfBuffer.length / 1024)} KB`,
          duration: `${pdfEndTime - pdfStartTime}ms`
        });
        break;
        
      } catch (pdfError) {
        console.error(`✗ PDF attempt ${i + 1} failed:`, pdfError.message);
        
        if (i === pdfStrategies.length - 1) {
          throw new Error(`All PDF generation attempts failed. Last error: ${pdfError.message}`);
        }
        
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (!pdfBuffer) {
      throw new Error('PDF generation failed - no buffer created');
    }

    // Close browser immediately after successful PDF generation
    await safeBrowserCleanup(browser);
    browser = null;

    await safeUpdateJob(jobId, { status: 'Processing', progress: 95 });

    // Upload to Supabase
    const filename = `report-${jobId}.pdf`;
    const path = `${brandId}/${filename}`;
    
    console.log('Uploading PDF...', {
      filename,
      path,
      size: `${Math.round(pdfBuffer.length / 1024)} KB`
    });

    const { error: uploadError, data } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(path, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload failed:', uploadError);
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    console.log('Upload successful');

    // Get public URL
    const { data: publicUrl } = supabase
      .storage
      .from('Creatives/brand-uploaded')
      .getPublicUrl(path);

    // Final success update
    const totalTime = Date.now() - startTime;
    await safeUpdateJob(jobId, {
      status: 'Download',
      progress: 100,
      downloadUrl: publicUrl.publicUrl,
      completedAt: new Date().toISOString(),
      summary: {
        totalSelectors: selectors.length,
        loadedSelectors: loadedSelectors.length,
        failedSelectors: failedSelectors.length,
        pdfSize: pdfBuffer.length,
        processingTime: `${Math.round(totalTime / 1000)}s`
      }
    });

    console.log(`\n=== PDF Generation Complete ===`);
    console.log('Success Summary:', {
      jobId,
      totalTime: `${Math.round(totalTime / 1000)}s`,
      pdfSize: `${Math.round(pdfBuffer.length / 1024)} KB`,
      selectorsLoaded: `${loadedSelectors.length}/${selectors.length}`,
      downloadUrl: publicUrl.publicUrl
    });

    res.json({ 
      success: true, 
      url: publicUrl.publicUrl,
      summary: {
        totalSelectors: selectors.length,
        loadedSelectors: loadedSelectors.length,
        failedSelectors: failedSelectors.length,
        pdfSize: pdfBuffer.length,
        processingTime: Math.round(totalTime / 1000)
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`\n=== PDF Generation Failed ===`);
    console.error('Error Details:', {
      jobId: reportJobId,
      error: error.message,
      totalTime: `${Math.round(totalTime / 1000)}s`,
      stack: error.stack?.split('\n').slice(0, 5).join('\n')
    });
    
    // Cleanup
    await safeBrowserCleanup(browser);
    
    // Update job status
    if (reportJobId) {
      await safeUpdateJob(reportJobId, {
        status: 'Failed',
        progress: 0,
        error: error.message,
        failedAt: new Date().toISOString()
      });
    }
    
    const statusCode = error.message.includes('Missing required fields') ? 400 : 500;
    res.status(statusCode).json({ 
      error: error.message,
      jobId: reportJobId
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    },
    uptime: Math.round(process.uptime()) + 's'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reliable PDF Generator running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});