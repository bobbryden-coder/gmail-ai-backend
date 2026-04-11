const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');
const rateLimit = require('express-rate-limit');
const { verifyGoogleToken } = require('../services/google-auth');
const StripeService = require('../services/stripe');

const router = express.Router();
const prisma = new PrismaClient();

// Cutoff date for card-on-file requirement (users created before this are grandfathered)
const CARD_REQUIRED_CUTOFF = new Date('2025-01-21T00:00:00Z');

// Send welcome email to new users
async function sendWelcomeEmail(email, name) {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: parseInt(process.env.SMTP_PORT, 10) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'Your first Linkwell email in 60 seconds',
      text: `Hi ${name},

Thanks for installing Linkwell.

Here's how to get your first personalised outreach email in 60 seconds:

1. Open any LinkedIn profile
2. Click the Linkwell icon in your Chrome toolbar
3. Choose your reason for reaching out
4. Hit Generate

Gmail opens with a ready-to-send draft — no copy-pasting, no templates.

If anything isn't working, just reply to this email.

Bob
Founder, Linkwell
getlinkwell.org`,
    });

    console.log(`📧 Welcome email sent to ${email}`);
  } catch (error) {
    console.error(`❌ Failed to send welcome email to ${email}:`, error.message);
  }
}

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register new user - starts 30-day free trial immediately (no card required)
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, name, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
      // No explicit select - let Prisma return all fields that exist
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Calculate trial dates (30 days from now)
    const trialStartDate = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 30);

    // Create user with 30-day trial (no card required)
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        name: name || '',
        password: hashedPassword,
        isPremium: true, // Full access during trial
        dailyUsage: 0,
        monthlyUsage: 0,
        subscriptionStatus: 'trialing',
        trialActive: true,
        trialStartDate: trialStartDate,
        trialEndDate: trialEndDate,
      }
    });

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        isPremium: true 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log(`✅ New user registered: ${user.email} - 30-day trial started`);

    res.status(201).json({
      success: true,
      message: 'Your 30-day free trial starts now! You\'ll be converted to freemium on day 31 unless you subscribe.',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: true,
        trialActive: true,
        trialStartDate: trialStartDate.toISOString(),
        trialEndDate: trialEndDate.toISOString(),
        trialDaysRemaining: 30,
        subscriptionStatus: 'trialing'
      },
      trial: {
        active: true,
        startDate: trialStartDate.toISOString(),
        endDate: trialEndDate.toISOString(),
        daysRemaining: 30,
        benefits: [
          '✅ 30 Days FREE - No Charge Yet',
          '✅ Full Pro Access During Trial',
          '✅ Auto-converts to freemium on day 31',
          '✅ Upgrade anytime to keep Pro features'
        ]
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login user
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
      // No explicit select - let Prisma return all fields that exist
    });

    if (!user) {
      console.log(`Login attempt for non-existent user: ${email.toLowerCase()}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user has a password (might have been created via Google OAuth)
    if (!user.password) {
      console.log(`Login attempt for Google OAuth user (no password): ${user.email}`);
      return res.status(401).json({ 
        error: 'This account was created with Google Sign-In. Please use "Sign in with Google" instead.',
        useGoogleSignIn: true
      });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        isPremium: user.isPremium 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Check if user needs to complete payment (created after cutoff, no subscription)
    const needsPayment = user.createdAt >= CARD_REQUIRED_CUTOFF && 
                         !user.stripeSubscriptionId && 
                         user.subscriptionStatus !== 'active' &&
                         user.subscriptionStatus !== 'trialing';

    let checkoutUrl = null;
    if (needsPayment) {
      const baseUrl = process.env.FRONTEND_URL || 'https://gmail-ai-backend.vercel.app';
      const checkoutResult = await StripeService.createTrialCheckoutSession(
        user.id,
        user.email,
        `${baseUrl}/payment-success`,
        `${baseUrl}/payment-cancelled`
      );
      if (checkoutResult.success) {
        checkoutUrl = checkoutResult.url;
      }
    }

    // Calculate trial days remaining if on trial
    let trialDaysRemaining = 0;
    if (user.subscriptionStatus === 'trialing' && user.trialEndDate) {
      const now = new Date();
      const trialEnd = new Date(user.trialEndDate);
      trialDaysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    console.log(`✅ User logged in: ${user.email} (ID: ${user.id})`);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: user.isPremium,
        dailyUsage: user.dailyUsage,
        monthlyUsage: user.monthlyUsage
      },
      subscription: {
        status: user.subscriptionStatus,
        trialDaysRemaining: trialDaysRemaining,
        trialEndDate: user.trialEndDate
      },
      requiresPayment: needsPayment,
      checkoutUrl: checkoutUrl
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login. Please try again.' });
  }
});

// Google OAuth authentication - returns checkout URL for new users
router.post('/google', async (req, res) => {
  try {
    console.log('Google OAuth request received:', {
      hasIdToken: !!req.body.idToken,
      hasEmail: !!req.body.email,
      hasGoogleId: !!req.body.googleId,
      email: req.body.email
    });

    const { idToken, email, googleId, name, picture } = req.body;

    let googleUser;

    // Support both ID token (for web apps) and direct user info (for Chrome extensions)
    if (email && googleId) {
      // Direct user info from Chrome extension
      console.log('Using direct user info from Chrome extension');
      googleUser = {
        email: email.toLowerCase(),
        name: name || email.split('@')[0],
        googleId: googleId,
        picture: picture
      };
    } else if (idToken) {
      // Verify Google ID token (for web apps)
      try {
        googleUser = await verifyGoogleToken(idToken);
        console.log('Google token verified successfully');
      } catch (tokenError) {
        console.error('Google token verification failed:', tokenError);
        if (email && googleId) {
          console.log('Token verification failed, using direct user info as fallback');
          googleUser = {
            email: email.toLowerCase(),
            name: name || email.split('@')[0],
            googleId: googleId,
            picture: picture
          };
        } else {
          return res.status(401).json({ 
            error: 'Failed to verify Google token',
            details: tokenError.message 
          });
        }
      }
    } else {
      console.error('Missing required fields for Google OAuth');
      return res.status(400).json({ 
        error: 'Either Google ID token or email and Google ID are required',
        received: { hasIdToken: !!idToken, hasEmail: !!email, hasGoogleId: !!googleId }
      });
    }
    
    if (!googleUser.email || !googleUser.googleId) {
      console.error('Invalid googleUser object:', googleUser);
      return res.status(400).json({ error: 'Email and Google ID are required' });
    }

    console.log('Processing Google OAuth for user:', googleUser.email);

    // Find existing user by email or googleId
    // Note: Using minimal select to avoid Prisma client schema mismatches
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: googleUser.email },
          { googleId: googleUser.googleId }
        ]
      }
      // No explicit select - let Prisma return all fields that exist
    });

    let isNewUser = false;

    if (user) {
      // User exists - update Google info if needed
      if (!user.googleId || user.googleId !== googleUser.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: googleUser.googleId,
            authProvider: 'google',
            name: user.name || googleUser.name
          }
        });
      }
      
      console.log(`✅ User logged in via Google: ${user.email} (ID: ${user.id})`);
    } else {
      // New user - create account with 30-day trial (no card required)
      isNewUser = true;
      console.log('Creating new user:', googleUser.email);
      
      // Calculate trial dates (30 days from now)
      const trialStartDate = new Date();
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 30);
      
      user = await prisma.user.create({
        data: {
          email: googleUser.email,
          name: googleUser.name,
          googleId: googleUser.googleId,
          authProvider: 'google',
          password: null,
          isPremium: true, // Full access during trial
          dailyUsage: 0,
          monthlyUsage: 0,
          subscriptionStatus: 'trialing',
          trialActive: true,
          trialStartDate: trialStartDate,
          trialEndDate: trialEndDate,
        }
      });
      console.log(`✅ New user registered via Google: ${user.email} (ID: ${user.id}) - 30-day trial started`);

      // Send welcome email (fire and forget - don't block auth response)
      sendWelcomeEmail(user.email, user.name).then(() => {
        console.log('✅ Welcome email sent to:', user.email);
      }).catch(err => {
        console.error('❌ Welcome email failed:', err.message);
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        isPremium: user.isPremium || user.subscriptionStatus === 'trialing'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Calculate trial days remaining if on trial
    let trialDaysRemaining = 0;
    if ((user.subscriptionStatus === 'trialing' || user.trialActive) && user.trialEndDate) {
      const now = new Date();
      const trialEnd = new Date(user.trialEndDate);
      trialDaysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    // Determine if user has full access (trial or paid)
    const hasFullAccess = user.subscriptionStatus === 'trialing' || 
                          user.subscriptionStatus === 'active' || 
                          user.trialActive;

    res.json({
      success: true,
      message: isNewUser 
        ? 'Your 30-day free trial starts now! You\'ll be converted to freemium on day 31 unless you subscribe.' 
        : 'Google authentication successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: hasFullAccess,
        dailyUsage: user.dailyUsage || 0,
        monthlyUsage: user.monthlyUsage || 0,
        trialActive: user.trialActive,
        trialEndDate: user.trialEndDate,
        trialDaysRemaining: trialDaysRemaining,
        subscriptionStatus: user.subscriptionStatus
      },
      subscription: {
        status: user.subscriptionStatus,
        trialActive: user.trialActive,
        trialDaysRemaining: trialDaysRemaining,
        trialEndDate: user.trialEndDate
      },
      isNewUser: isNewUser,
      trial: isNewUser ? {
        active: true,
        startDate: user.trialStartDate,
        endDate: user.trialEndDate,
        daysRemaining: 30,
        benefits: [
          '✅ 30 Days FREE - No Charge Yet',
          '✅ Full Pro Access During Trial',
          '✅ Auto-converts to freemium on day 31',
          '✅ Upgrade anytime to keep Pro features'
        ]
      } : undefined
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ 
      error: 'Failed to authenticate with Google',
      details: error.message 
    });
  }
});

// Verify token
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
      // No explicit select - let Prisma return all fields that exist
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check if user needs to complete payment
    const needsPayment = user.createdAt >= CARD_REQUIRED_CUTOFF && 
                         !user.stripeSubscriptionId && 
                         user.subscriptionStatus !== 'active' &&
                         user.subscriptionStatus !== 'trialing';

    // Calculate trial days remaining
    let trialDaysRemaining = 0;
    if (user.subscriptionStatus === 'trialing' && user.trialEndDate) {
      const now = new Date();
      const trialEnd = new Date(user.trialEndDate);
      trialDaysRemaining = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: user.isPremium
      },
      subscription: {
        status: user.subscriptionStatus,
        trialDaysRemaining: trialDaysRemaining,
        trialEndDate: user.trialEndDate
      },
      requiresPayment: needsPayment
    });

  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
});

module.exports = router;
