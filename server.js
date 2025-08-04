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

// Enhanced Chrome detection and configuration
function getChromeExecutablePath() {
  const possiblePaths = [
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/app/.apt/usr/bin/google-chrome', // Heroku buildpack path
    '/opt/google/chrome/chrome', // Some Docker images
  ];

  for (const path of possiblePaths) {
    if (path) return path;
  }
  
  return null; // Let Puppeteer use bundled Chromium
}

// Create optimized launch options for cloud environments
function createLaunchOptions() {
  const executablePath = getChromeExecutablePath();
  
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-field-trial-config',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-crash-upload',
    '--no-default-browser-check',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-device-discovery-notifications',
    '--disable-software-rasterizer',
    '--disable-background-downloads',
    '--disable-add-to-shelf',
    '--disable-client-side-phishing-detection',
    '--disable-datasaver-prompt',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--safebrowsing-disable-auto-update',
    '--ignore-gpu-blacklist',
    '--ignore-certificate-errors',
    '--ignore-ssl-errors',
    '--ignore-certificate-errors-spki-list'
  ];

  // Add memory optimization for constrained environments
  if (process.env.NODE_ENV === 'production') {
    baseArgs.push(
      '--single-process', // Use only in production, can be unstable
      '--memory-pressure-off',
      '--max_old_space_size=512'
    );
  }

  const options = {
    headless: true,
    args: baseArgs,
    timeout: 60000, // Increase timeout to 60 seconds
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  };

  if (executablePath) {
    options.executablePath = executablePath;
    console.log(`Using Chrome at: ${executablePath}`);
  } else {
    console.log('Using bundled Chromium');
  }

  return options;
}

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
      baseURL,
      level
    } = req.body;
    
    console.log('Payload body:', {
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
      level,
      baseURL
    });
    
    jobId = requestJobId;
    console.log("Processing job:", jobId);

    await ReportStorage.updateJob(jobId, {
      status: 'Processing',
      progress: 10,
    });

    console.log('Launching browser...');
    const launchOptions = createLaunchOptions();
    
    // Add retry logic for browser launch
    let launchAttempts = 0;
    const maxLaunchAttempts = 3;
    
    while (launchAttempts < maxLaunchAttempts) {
      try {
        browser = await puppeteer.launch(launchOptions);
        console.log('Browser launched successfully');
        break;
      } catch (launchError) {
        launchAttempts++;
        console.error(`Browser launch attempt ${launchAttempts} failed:`, launchError.message);
        
        if (launchAttempts >= maxLaunchAttempts) {
          throw new Error(`Failed to launch browser after ${maxLaunchAttempts} attempts: ${launchError.message}`);
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try with different options on retry
        if (launchAttempts === 2) {
          launchOptions.args.push('--disable-extensions');
          delete launchOptions.executablePath; // Try bundled Chromium
        }
      }
    }

    const page = await browser.newPage();
    
    // Set page configuration
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    );

    // Set page timeouts
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);

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

    await page.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    });

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 20 });

    console.log('Navigating to page...');
    
    // Enhanced navigation with retry logic
    let navigationAttempts = 0;
    const maxNavigationAttempts = 2;
    
    while (navigationAttempts < maxNavigationAttempts) {
      try {
        await page.goto(reportUrl, {
          waitUntil: 'networkidle2',
          timeout: 180000,
        });
        console.log('Navigation successful');
        break;
      } catch (navError) {
        navigationAttempts++;
        console.error(`Navigation attempt ${navigationAttempts} failed:`, navError.message);
        
        if (navigationAttempts >= maxNavigationAttempts) {
          throw navError;
        }
        
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Wait for page to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('Waiting for main container...');
    await page.waitForSelector('#report-home-page', { 
      visible: true, 
      timeout: 180000 
    });

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 40 });

    const chartSelectors = [
      '[id="Age & Gender Split Chart 01"]',
      '[id="Age & Gender Split Chart 02"]',
      '[id="Best Time Chart"]',
      '[id="Device Split Chart"]',
    ];

    console.log('Waiting for charts to load...');
    for (const selector of chartSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 120000 });
        console.log(`Chart loaded: ${selector}`);
      } catch (error) {
        console.warn(`Chart failed to load: ${selector}`, error.message);
      }
    }

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 70 });

    // Additional wait to ensure all content is rendered
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      timeout: 120000,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
      preferCSSPageSize: false,
    });

    // Close browser immediately after PDF generation
    await browser.close();
    browser = null;
    console.log('Browser closed successfully');

    await ReportStorage.updateJob(jobId, { status: 'Processing', progress: 85 });

    const filename = `report-${jobId}.pdf`;
    const path = `${brandId}/${filename}`;

    console.log('Uploading PDF to Supabase...');
    const { error: uploadError } = await supabase
      .storage
      .from('Creatives/brand-uploaded')
      .upload(path, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
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

    console.log('Report generation completed successfully');
    res.json({ success: true, url: publicUrl.publicUrl });

  } catch (error) {
    console.error('Report generation failed:', error);
    
    // Ensure browser is closed in case of error
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed after error');
      } catch (closeError) {
        console.error('Failed to close browser:', closeError);
      }
    }
    
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});