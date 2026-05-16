const express = require('express');
const { PrismaClient } = require('@prisma/client');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const router = express.Router();
const prisma = new PrismaClient();

// Verify cron secret for security
function verifyCronSecret(req, res, next) {
  const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
  
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET not configured');
    return res.status(500).json({ error: 'Cron not configured' });
  }
  
  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('Invalid cron secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// POST /api/cron/check-trial-expiry
// Runs daily to find expired trials and convert them to freemium (NOT charge them)
router.post('/check-trial-expiry', verifyCronSecret, async (req, res) => {
  try {
    console.log('🕐 Starting trial expiry check (freemium conversion)...');
    
    const now = new Date();
    
    // Find all users with expired trials who are still in trialing status
    const expiredTrialUsers = await prisma.user.findMany({
      where: {
        OR: [
          { trialActive: true },
          { subscriptionStatus: 'trialing' }
        ],
        trialEndDate: {
          lte: now
        },
        // Don't touch users who already have active paid subscriptions
        subscriptionStatus: {
          notIn: ['active', 'freemium']
        }
      }
    });
    
    console.log(`Found ${expiredTrialUsers.length} users with expired trials to convert to freemium`);
    
    let converted = 0;
    let errors = [];
    
    for (const user of expiredTrialUsers) {
      try {
        console.log(`Converting user ${user.id} (${user.email}) to freemium`);
        
        // Convert to freemium - DO NOT create Stripe subscription or charge
        await prisma.user.update({
          where: { id: user.id },
          data: {
            trialActive: false,
            isPremium: false, // No longer premium - now freemium with limits
            subscriptionStatus: 'freemium',
          }
        });
        
        console.log(`✅ User ${user.email} converted to freemium`);
        converted++;
        
      } catch (userError) {
        console.error(`❌ Error converting user ${user.id}:`, userError.message);
        errors.push({ userId: user.id, email: user.email, error: userError.message });
      }
    }
    
    console.log(`🏁 Trial expiry check complete. Converted to freemium: ${converted}, Errors: ${errors.length}`);
    
    res.json({
      success: true,
      message: `Converted ${converted} users to freemium`,
      converted: converted,
      total: expiredTrialUsers.length,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('❌ Trial expiry cron error:', error);
    res.status(500).json({ error: 'Failed to process trial expiries' });
  }
});

// GET /api/cron/check-trial-expiry - Called by Vercel Cron daily
router.get('/check-trial-expiry', verifyCronSecret, async (req, res) => {
  try {
    console.log('🕐 Starting trial expiry check (freemium conversion)...');

    const now = new Date();

    // Find all users with expired trials who are still in trialing status
    const expiredTrialUsers = await prisma.user.findMany({
      where: {
        OR: [
          { trialActive: true },
          { subscriptionStatus: 'trialing' }
        ],
        trialEndDate: {
          lte: now
        },
        // Don't touch users who already have active paid subscriptions
        subscriptionStatus: {
          notIn: ['active', 'freemium']
        }
      }
    });

    console.log(`Found ${expiredTrialUsers.length} users with expired trials to convert to freemium`);

    let converted = 0;
    let errors = [];

    for (const user of expiredTrialUsers) {
      try {
        console.log(`Converting user ${user.id} (${user.email}) to freemium`);

        // Convert to freemium - DO NOT create Stripe subscription or charge
        await prisma.user.update({
          where: { id: user.id },
          data: {
            trialActive: false,
            isPremium: false, // No longer premium - now freemium with limits
            subscriptionStatus: 'freemium',
          }
        });

        console.log(`✅ User ${user.email} converted to freemium`);
        converted++;

      } catch (userError) {
        console.error(`❌ Error converting user ${user.id}:`, userError.message);
        errors.push({ userId: user.id, email: user.email, error: userError.message });
      }
    }

    console.log(`🏁 Trial expiry check complete. Converted to freemium: ${converted}, Errors: ${errors.length}`);

    res.json({
      success: true,
      message: `Converted ${converted} users to freemium`,
      converted: converted,
      total: expiredTrialUsers.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Trial expiry cron error:', error);
    res.status(500).json({ error: 'Failed to process trial expiries' });
  }
});

// GET /api/cron/send-nudge-emails - Called by Vercel Cron daily at 9am UTC
router.get('/send-nudge-emails', verifyCronSecret, async (req, res) => {
  try {
    console.log('🕐 Starting nudge email check...');

    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    // Find users who signed up 3+ days ago, have never used the product, and haven't been nudged
    const inactiveUsers = await prisma.user.findMany({
      where: {
        createdAt: {
          lte: threeDaysAgo
        },
        OR: [
          { dailyUsage: 0 },
          { dailyUsage: null }
        ],
        AND: [
          {
            OR: [
              { monthlyUsage: 0 },
              { monthlyUsage: null }
            ]
          }
        ],
        nudgeEmailSent: false,
      }
    });

    console.log(`Found ${inactiveUsers.length} inactive users to nudge`);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: parseInt(process.env.SMTP_PORT, 10) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    let sent = 0;
    let errors = [];

    for (const user of inactiveUsers) {
      try {
        const name = user.name || user.email.split('@')[0];

        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: user.email,
          subject: 'Have you tried Linkwell yet?',
          text: `Hi ${name},

You installed Linkwell a few days ago but haven't had a chance to try it yet.

Here's the quickest way to see what it does:

1. Go to linkedin.com/in/satyanadella (or any LinkedIn profile)
2. Click the Linkwell icon in your Chrome toolbar
3. Hit Generate

That's it — a personalised email appears in your Gmail in about 10 seconds.

If something isn't working or you can't find the extension, just reply to this email.

Bob
Founder, Linkwell`,
        });

        await prisma.user.update({
          where: { id: user.id },
          data: { nudgeEmailSent: true },
        });

        console.log(`📧 Nudge email sent to ${user.email}`);
        sent++;

      } catch (userError) {
        console.error(`❌ Error nudging user ${user.id}:`, userError.message);
        errors.push({ userId: user.id, email: user.email, error: userError.message });
      }
    }

    console.log(`🏁 Nudge email check complete. Sent: ${sent}, Errors: ${errors.length}`);

    res.json({
      success: true,
      message: `Sent ${sent} nudge emails`,
      sent: sent,
      total: inactiveUsers.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Nudge email cron error:', error);
    res.status(500).json({ error: 'Failed to send nudge emails' });
  }
});

module.exports = router;
