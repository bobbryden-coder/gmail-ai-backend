const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

// Handle uncaught errors gracefully for Vercel
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const authRoutes = require('./routes/auth');
const aiRoutes = require('./routes/ai');
const userRoutes = require('./routes/users');
const stripeRoutes = require('./routes/stripe');
const passwordResetRoutes = require('./routes/password-reset');
const trialRoutes = require('./routes/trial');
const adminRoutes = require('./routes/admin');
const recruiterRoutes = require('./routes/recruiter');
const StripeService = require('./services/stripe');
const cronRoutes = require('./routes/cron');
const portalRoutes = require('./routes/portal');
const openaiService = require('./services/openai');

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow Chrome extensions
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    
    // Allow localhost
    if (origin.startsWith('http://localhost:') ||
        origin.startsWith('https://localhost:') ||
        origin === 'http://localhost:3000') {
      return callback(null, true);
    }
    
    // Allow Gmail (for content scripts)
    if (origin.includes('mail.google.com') || origin.includes('gmail.com')) {
      return callback(null, true);
    }
    
    // Allow same-origin requests (for password reset page)
    if (origin && origin.includes('vercel.app')) {
      return callback(null, true);
    }
    
    // In production, you might want to restrict this
    if (process.env.NODE_ENV === 'production') {
      // In production, be more permissive for Chrome extensions
      // Chrome extensions can make requests from any page
      console.log('CORS: Allowing request from:', origin);
      return callback(null, true);
    }
    
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Cron-Secret', 'X-Admin-Token']
}));

// Debug middleware (skip body log for webhook to avoid huge payloads)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.path !== '/api/stripe/webhook' && req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', req.body);
  }
  next();
});

// ----- STRIPE WEBHOOK (must be BEFORE express.json()) -----
// Stripe requires the RAW body for signature verification. express.json() consumes
// the body, so we handle the webhook here with express.raw() and never touch json.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('🔔 [STRIPE WEBHOOK] POST /api/stripe/webhook received');
    try {
      const signature = req.headers['stripe-signature'];
      if (!signature) {
        console.error('❌ [STRIPE WEBHOOK] Missing Stripe-Signature header');
        return res.status(400).json({ error: 'Missing Stripe signature' });
      }
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error('❌ [STRIPE WEBHOOK] STRIPE_WEBHOOK_SECRET not set');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }
      console.log('📩 [STRIPE WEBHOOK] Processing event (raw body length:', req.body?.length ?? 0, ')');
      const result = await StripeService.handleWebhook(req.body, signature);
      console.log('✅ [STRIPE WEBHOOK] Processed successfully:', result?.message ?? 'ok');
      return res.status(200).json({ received: true, success: true, message: result?.message ?? 'Webhook processed' });
    } catch (err) {
      console.error('❌ [STRIPE WEBHOOK] Error:', err.message);
      console.error('❌ [STRIPE WEBHOOK] Stack:', err.stack);
      return res.status(200).json({
        received: true,
        error: err.message,
        note: 'Error logged; 200 returned to avoid Stripe retries',
      });
    }
  }
);

app.use(express.json());

// Serve static files for payment pages
app.use(express.static('public'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordResetRoutes); // Add password reset routes to auth
app.use('/api/ai', aiRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/trial', trialRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/recruiter', recruiterRoutes);
app.use('/api/portal', portalRoutes);

// Summarize email endpoint (direct route for /api/summarize)
app.post('/api/summarize', async (req, res) => {
  try {
    const { email, options = {} } = req.body;

    if (!email || !email.body) {
      return res.status(400).json({ 
        error: 'Email content is required',
        received: { hasEmail: !!email, hasBody: !!email?.body }
      });
    }

    console.log('📧 Summarize request:', {
      subject: email.subject,
      sender: email.sender,
      bodyLength: email.body?.length || 0
    });

    // Use the existing OpenAI service to generate summary
    const result = await openaiService.generateEmailResponse(
      {
        subject: email.subject || '',
        sender: email.sender || '',
        body: email.body || ''
      },
      options.style || 'brief',
      'response' // mode
    );

    if (!result.success) {
      console.error('Summarization failed:', result.error);
      return res.status(500).json({ 
        error: 'Failed to generate summary',
        details: result.error || 'Unknown error'
      });
    }

    // Parse the AI response
    let parsedResponse;
    try {
      let cleanResponse = result.response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsedResponse = JSON.parse(cleanResponse);
    } catch (parseError) {
      console.error('Failed to parse summary response:', parseError);
      // Return a simple summary if parsing fails
      parsedResponse = {
        summary: result.response.substring(0, 200) + (result.response.length > 200 ? '...' : ''),
        responses: [],
        actions: []
      };
    }

    // Return summary in a clean format
    res.json({
      success: true,
      summary: parsedResponse.summary || 'No summary available',
      actions: parsedResponse.actions || [],
      keyPoints: parsedResponse.keyPoints || [],
      sentiment: parsedResponse.sentiment,
      urgency: parsedResponse.urgency,
      tokensUsed: result.tokensUsed,
      cost: result.cost
    });

  } catch (error) {
    console.error('Summarization error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Payment redirect pages
app.get('/payment-success', (req, res) => {
  res.sendFile('payment-success.html', { root: path.join(__dirname, '..', 'public') });
});

app.get('/payment-cancelled', (req, res) => {
  res.sendFile('payment-cancelled.html', { root: path.join(__dirname, '..', 'public') });
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile('login.html', { root: path.join(__dirname, '..', 'public') });
});

// Password reset page
app.get('/reset-password', (req, res) => {
  res.sendFile('reset-password.html', { root: path.join(__dirname, '..', 'public') });
});

// Privacy policy page
app.get('/privacy-policy', (req, res) => {
  res.sendFile('privacy-policy.html', { root: path.join(__dirname, '..', 'public') });
});

// Health check (no database required)
app.get('/health', (req, res) => {
  try {
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      vercel: !!process.env.VERCEL
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Export app for Vercel serverless functions
module.exports = app;

// Only start server if not in Vercel environment
if (process.env.VERCEL !== '1' && !process.env.VERCEL_ENV) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔐 Auth endpoints:`);
    console.log(`   - POST /api/auth/register`);
    console.log(`   - POST /api/auth/login`);
    console.log(`   - GET  /api/auth/verify`);
    console.log(`🤖 AI endpoints:`);
    console.log(`   - POST /api/ai/generate (requires auth)`);
    console.log(`   - GET  /api/ai/usage`);
    console.log(`💳 Stripe endpoints:`);
    console.log(`   - GET  /api/stripe/pricing`);
    console.log(`   - POST /api/stripe/create-checkout-session`);
    console.log(`   - POST /api/stripe/success`);
    console.log(`   - POST /api/stripe/webhook (raw body)`);
    console.log(`   - POST /api/stripe/cancel-subscription`);
    console.log(`   - GET  /api/stripe/subscription-status`);
    console.log(`🆓 Trial endpoints:`);
    console.log(`   - GET  /api/trial/status`);
    console.log(`⏰ Cron endpoints:`);
    console.log(`   - POST /api/cron/check-trial-expiry`);
  });
}
